import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { type AgentState, type Conversation, type ConversationView, createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { User } from "./auth.ts";
import type { Llm } from "./llm.ts";
import type { SearchResponse } from "./search/indexer.ts";

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
	"You are Golem, a family assistant. Several family members can write in one thread; each message starts with its author's name. Answer concisely. Use the recall tool to look up anything said or stored earlier in this workspace before saying you do not know.";

export type ThreadHooks = {
	/** Searches one workspace; the recall tool of a thread only ever passes its own workspace. */
	readonly recall: (workspaceId: string, query: string, limit: number) => Promise<SearchResponse>;
	/** Called after every commit to a thread, such as a message or a finished answer. */
	readonly changed: (workspaceId: string) => void;
};

type Open = { readonly harness: Harness; readonly conversation: Conversation };

/** One Pi Durable session per thread, in `data/workspaces/<workspace>/threads/<thread>/session.sqlite`. */
export class Threads {
	private readonly open = new Map<string, Promise<Open>>();

	constructor(
		private readonly dataDirectory: string,
		private readonly llm: Llm,
		private readonly hooks: ThreadHooks,
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
		const path = join(this.dataDirectory, "workspaces", thread.workspaceId, "threads", thread.id, "session.sqlite");
		const registry = createRegistry();
		registry.install(defineExtension({ name: "golem", tools: [this.recallTool(thread.workspaceId)] }));
		const harness = await Harness.open(await openNodeSqliteStorage(path), { models: this.llm.models, registry }, BACKGROUND_CONTEXT);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: this.currentModel(), thinkingLevel: this.llm.effort(), instructions: INSTRUCTIONS },
		});
		const changes = await conversation.watch(BACKGROUND_CONTEXT);
		changes.start(async () => this.hooks.changed(thread.workspaceId));
		// Continue a run that a previous process left unfinished.
		harness.resume();
		return { harness, conversation };
	}

	/** Lets the agent search its own workspace: threads, notes, files, and captures. */
	private recallTool(workspaceId: string) {
		return defineTool({
			name: "recall",
			description:
				"Search everything in this workspace: earlier threads, notes, files, and captured mail or chats. Use it to recall facts, decisions, and what people said.",
			parameters: Type.Object({
				query: Type.String({ description: "What to look for, in plain words" }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "How many results; default 8" })),
			}),
			replay: "safe",
			execute: async (args) => {
				const { results } = await this.hooks.recall(workspaceId, args.query, args.limit ?? 8);
				const text = results.length
					? results
							.map((result, number) => {
								const when = new Date(result.updatedAt).toISOString().slice(0, 10);
								return `${number + 1}. [${result.kind}] ${result.title} (${when}): ${result.snippet}`;
							})
							.join("\n")
					: "Nothing found in this workspace.";
				return { output: [{ type: "text", text }] };
			},
		});
	}

	/** Threads follow the model and effort chosen in settings, also after they change. */
	private async useCurrentModel(conversation: Conversation): Promise<void> {
		const model = this.currentModel();
		const thinkingLevel = this.llm.effort();
		const view = await conversation.watch(BACKGROUND_CONTEXT);
		await view.stop();
		const stored = view.value.docs["pi.agent"] as AgentState | undefined;
		if (stored?.model?.provider !== model.provider || stored.model.modelId !== model.modelId || stored.thinkingLevel !== thinkingLevel) {
			await conversation.configure({ model, thinkingLevel }, BACKGROUND_CONTEXT);
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
