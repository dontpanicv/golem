import { randomUUID } from "node:crypto";
import { HttpError } from "../platform/errors.ts";
import type { Threads } from "../threads/threads.ts";
import { phoneTools } from "./tools.ts";

/** One call of an agent's phone tool, as the app gets it. */
export interface PhoneCall {
  readonly id: string;
  /** The workspace of the turn, whose files the app reads for a call that names one. */
  readonly workspaceId: string;
  /** The tool's name without `phone_`, such as `alarm_set`. */
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** What the phone answers: its text, and the pictures that it took or found. */
export interface PhoneReply {
  readonly text: string;
  readonly images: readonly File[];
}

/** How long a call waits for the phone: the person may first allow access, or send the message that it opened. */
const ANSWER_TIMEOUT = 3 * 60_000;

interface Link {
  readonly send: (call: PhoneCall) => void;
}

interface Pending {
  readonly userId: string;
  readonly link: Link;
  readonly settle: (outcome: PhoneReply | Error) => void;
}

/**
 * The iPhones of the people while the Golem app is open on them. The app holds a stream open; Golem sends each call of
 * an agent's phone tool on it, and the app answers with the result. A call waits only in memory; nothing is stored.
 */
export class Phone {
  /** The open streams of each person, newest last: a call goes to the phone that the person opened last. */
  private readonly links = new Map<string, Link[]>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly threads: Pick<Threads, "requester">) {}

  tools(workspaceId: string) {
    return phoneTools(this, this.threads, workspaceId);
  }

  /** Sends the person's calls to `send` until the returned function closes the stream; its waiting calls then fail. */
  connect(userId: string, send: (call: PhoneCall) => void): () => void {
    const link: Link = { send };
    this.links.set(userId, [...(this.links.get(userId) ?? []), link]);
    return () => {
      const rest = (this.links.get(userId) ?? []).filter(
        (other) => other !== link
      );
      if (rest.length > 0) {
        this.links.set(userId, rest);
      } else {
        this.links.delete(userId);
      }
      for (const call of [...this.pending.values()]) {
        if (call.link === link) {
          call.settle(
            new Error(
              "The Golem app on the phone closed before it answered. Ask the person to open it and try again."
            )
          );
        }
      }
    };
  }

  /** Runs a tool on the person's phone and waits for its answer. */
  call(
    userId: string,
    workspaceId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<PhoneReply> {
    const link = this.links.get(userId)?.at(-1);
    if (!link) {
      return Promise.reject(
        new Error(
          "The person's iPhone is not connected: phone tools work only while the Golem app is open on it. Ask them to open it, or use a reminder instead."
        )
      );
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => settle(new Error("The phone did not answer in 3 minutes.")),
        ANSWER_TIMEOUT
      );
      const aborted = () => settle(new Error("The call was stopped."));
      const settle = (outcome: PhoneReply | Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.pending.delete(id);
        if (outcome instanceof Error) {
          reject(outcome);
        } else {
          resolve(outcome);
        }
      };
      signal?.addEventListener("abort", aborted, { once: true });
      this.pending.set(id, { userId, link, settle });
      link.send({ id, workspaceId, name, arguments: args });
    });
  }

  /** The phone's answer to a call it got: its text, or the error that the tool then fails with. */
  answer(
    userId: string,
    callId: string,
    answer: {
      readonly text?: string;
      readonly error?: string;
      readonly images: readonly File[];
    }
  ): void {
    const call = this.pending.get(callId);
    if (!call || call.userId !== userId) {
      throw new HttpError(404, "There is no such call");
    }
    call.settle(
      answer.error === undefined
        ? { text: answer.text ?? "", images: answer.images }
        : new Error(answer.error)
    );
  }
}
