import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { type Conversation, type ConversationView, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { User } from "./auth.ts";
import type { Llm } from "./llm.ts";

export type ThreadRef = { readonly id: string; readonly workspaceId: string };

export type Message = {
	readonly id: string;
	readonly authorId: string | null;
	readonly author: string;
	readonly agent: boolean;
	readonly text: string;
	readonly time: number;
	readonly failed: boolean;
	readonly streaming: boolean;
};

export type ThreadMessages = { readonly messages: readonly Message[]; readonly running: boolean };

const AUTHORED = "golem.message";
const INSTRUCTIONS =
	"You are Golem, a family assistant. Several family members can write in one thread; each message starts with its author's name. Answer concisely.";

type Open = { readonly harness: Harness; readonly conversation: Conversation };

/** One Pi Durable session per thread, in `<data>/workspaces/<workspace>/threads/<thread>.sqlite`. */
export class Threads {
	private readonly open = new Map<string, Promise<Open>>();

	constructor(
		private readonly dataDirectory: string,
		private readonly llm: Llm,
	) {}

	/** Sends a family member's message; the agent answers in the background. */
	async send(thread: ThreadRef, user: User, text: string): Promise<void> {
		const { conversation } = await this.session(thread);
		await this.useCurrentModel(conversation);
		await conversation.submit(
			{
				type: "input",
				content: `${user.name}: ${text}`,
				entry: { kind: AUTHORED, data: { authorId: user.id, author: user.name, text } },
			},
			BACKGROUND_CONTEXT,
		);
	}

	async messages(thread: ThreadRef): Promise<ThreadMessages> {
		const { conversation } = await this.session(thread);
		const watch = await conversation.watch(BACKGROUND_CONTEXT);
		await watch.stop();
		return threadMessages(watch.value);
	}

	/** Calls `listener` with the current messages, then after every change, until the returned stop is called. */
	async watch(thread: ThreadRef, listener: (messages: ThreadMessages) => void): Promise<() => Promise<void>> {
		const { conversation } = await this.session(thread);
		const watch = await conversation.watch(BACKGROUND_CONTEXT);
		listener(threadMessages(watch.value));
		watch.start(async (view) => listener(threadMessages(view)));
		return async () => void (await watch.stop());
	}

	async closeAll(): Promise<void> {
		const sessions = await Promise.allSettled(this.open.values());
		this.open.clear();
		for (const session of sessions) if (session.status === "fulfilled") await session.value.harness.close(BACKGROUND_CONTEXT);
	}

	private session(thread: ThreadRef): Promise<Open> {
		let session = this.open.get(thread.id);
		if (!session) {
			session = this.openSession(thread);
			this.open.set(thread.id, session);
			session.catch(() => this.open.delete(thread.id));
		}
		return session;
	}

	private async openSession(thread: ThreadRef): Promise<Open> {
		const path = join(this.dataDirectory, "workspaces", thread.workspaceId, "threads", `${thread.id}.sqlite`);
		const harness = await Harness.open(
			await openNodeSqliteStorage(path),
			{ models: this.llm.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: this.currentModel(), instructions: INSTRUCTIONS },
		});
		// Continue a run that a previous process left unfinished.
		harness.resume();
		return { harness, conversation };
	}

	/** Threads follow the model chosen in settings, also after it changes. */
	private async useCurrentModel(conversation: Conversation): Promise<void> {
		const model = this.currentModel();
		const view = await conversation.watch(BACKGROUND_CONTEXT);
		await view.stop();
		const stored = (view.value.docs["pi.agent"] as { model?: { provider?: string; modelId?: string } } | undefined)?.model;
		if (stored?.provider !== model.provider || stored.modelId !== model.modelId) {
			await conversation.configure({ model }, BACKGROUND_CONTEXT);
		}
	}

	private currentModel() {
		return { provider: this.llm.providerId, modelId: this.llm.model() };
	}
}

export function threadMessages(view: ConversationView): ThreadMessages {
	const messages: Message[] = [];
	for (const entry of view.entries) {
		const model = entry.model?.[0];
		if (entry.kind === AUTHORED) {
			const data = entry.data as { authorId: string; author: string; text: string };
			const time = (model as UserMessage | undefined)?.timestamp ?? 0;
			messages.push({ id: String(entry.id), authorId: data.authorId, author: data.author, agent: false, text: data.text, time, failed: false, streaming: false });
		} else if (model?.role === "assistant") {
			messages.push(agentMessage(String(entry.id), model, false));
		}
	}
	const live = (view.docs["pi.live"] ?? {}) as { generation?: { message?: AssistantMessage }; tools?: Record<string, unknown> };
	if (live.generation?.message) messages.push(agentMessage("streaming", live.generation.message, true));
	const running = live.generation !== undefined || Object.keys(live.tools ?? {}).length > 0;
	// A tool-only turn has no text to show.
	return { messages: messages.filter((message) => message.text !== "" || message.streaming), running };
}

function agentMessage(id: string, message: AssistantMessage, streaming: boolean): Message {
	const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	const failed = !streaming && text === "" && message.errorMessage !== undefined;
	return {
		id,
		authorId: null,
		author: "Golem",
		agent: true,
		text: failed ? message.errorMessage! : text,
		time: message.timestamp,
		failed,
		streaming,
	};
}
