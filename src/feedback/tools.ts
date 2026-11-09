import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { randomUUIDv5 } from "bun";
import type { Chats } from "../chats/chats.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import type { FeedbackReports } from "./feedback.ts";

/** The agent tool that reports a problem with Golem itself to the server's owner. */
export function feedbackTools(
  feedback: Pick<FeedbackReports, "report">,
  workspaces: Pick<Workspaces, "chatOf">,
  chats: Pick<Chats, "requester">,
  workspaceId: string
) {
  return [
    defineTool({
      name: "feedback_report",
      description:
        "Tell the developers of Golem about Golem itself: a tool that failed or answered wrong (error), a tool or capability you needed that does not exist (missing), or an easier or faster way to do the task (better). Describe Golem, not the person: no names, messages, or personal data. Report once, then continue the task. A website that blocks the browser with a bot check is no fault of Golem: do not report it.",
      parameters: Type.Object({
        kind: Type.Union(
          [
            Type.Literal("error"),
            Type.Literal("missing"),
            Type.Literal("better"),
          ],
          { description: "error, missing, or better" }
        ),
        tool: Type.Optional(
          Type.String({ description: "The name of the tool it is about" })
        ),
        summary: Type.String({ description: "One line" }),
        detail: Type.String({
          description:
            "What you tried, the error text, what you expected, and what would help",
        }),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const chat = workspaces.chatOf(workspaceId, api.conversationId);
        const person = await chats.requester(workspaceId, api.conversationId);
        feedback.report(workspaceId, {
          ...args,
          id: randomUUIDv5(`golem:${workspaceId}:${api.taskId}`, "url"),
          chatId: chat?.id ?? null,
          personId: person?.id ?? null,
        });
        return { output: [{ type: "text", text: "Reported." }] };
      },
    }),
  ];
}
