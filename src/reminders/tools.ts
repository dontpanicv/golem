import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { randomUUIDv5 } from "bun";
import type { Threads } from "../threads/threads.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import type { Reminder, Reminders } from "./reminders.ts";

/** Agent tools for the one-time reminders of a workspace. */
export function reminderTools(
  reminders: Reminders,
  workspaces: Pick<Workspaces, "agentMember" | "members" | "threadOf">,
  threads: Pick<Threads, "requester">,
  workspaceId: string
) {
  const at = Type.String({
    description:
      "The local date and time with its UTC offset, such as 2026-11-01T09:00:00+01:00",
  });
  const timeZone = Type.String({
    description: "IANA time zone of the recipient, such as Europe/Prague",
  });
  const text = Type.String({ description: "What to remind the person about" });
  const reminder = Type.String({ description: "The reminder id" });
  const actorFor = async (
    conversationId: Parameters<Threads["requester"]>[1]
  ) => {
    const asker = await threads.requester(workspaceId, conversationId);
    return {
      asker,
      actor: asker ?? workspaces.agentMember(workspaceId),
      realm: workspaces.threadOf(workspaceId, conversationId)?.realm ?? null,
    };
  };

  return [
    defineTool({
      name: "reminders_create",
      description:
        "Schedule one reminder for one exact future date and time. Use a routine for repeated work. Give the recipient's name when it is not the person who asked. Confirm the saved time in your answer.",
      parameters: Type.Object({
        text,
        at,
        timeZone,
        recipient: Type.Optional(
          Type.String({ description: "Name of a member of this workspace" })
        ),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const { actor, asker } = await actorFor(api.conversationId);
        const source = workspaces.threadOf(workspaceId, api.conversationId);
        if (!source) {
          throw new Error("This tool works only in a thread.");
        }
        const members = workspaces.members(workspaceId, actor);
        const matches = args.recipient
          ? members.filter(
              (member) =>
                member.name.toLowerCase() === args.recipient!.toLowerCase()
            )
          : members.filter((member) => member.userId === asker?.id);
        if (matches.length !== 1) {
          throw new Error(
            "Name exactly one member of this workspace as the recipient."
          );
        }
        const created = reminders.create(
          workspaceId,
          actor,
          source.id,
          matches[0]!.userId,
          {
            ...args,
            createdBy: asker?.id ?? null,
            id: randomUUIDv5(`golem:${workspaceId}:${api.taskId}`, "url"),
          }
        );
        return { output: [{ type: "text", text: describe(created) }] };
      },
    }),
    defineTool({
      name: "reminders_list",
      description:
        "List the one-time reminders of this workspace, including delivered and cancelled ones.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api) => {
        const { actor, realm } = await actorFor(api.conversationId);
        const result = reminders.list(workspaceId, actor, realm);
        return {
          output: [
            {
              type: "text",
              text: result.map(describe).join("\n\n") || "No reminders.",
            },
          ],
        };
      },
    }),
    defineTool({
      name: "reminders_update",
      description: "Change a pending one-time reminder.",
      parameters: Type.Object({ reminder, text, at, timeZone }),
      replay: "safe",
      execute: async ({ reminder: id, ...input }, api) => {
        const { actor, asker, realm } = await actorFor(api.conversationId);
        return {
          output: [
            {
              type: "text",
              text: describe(
                reminders.update(workspaceId, actor, realm, id, {
                  ...input,
                  createdBy: asker?.id ?? null,
                })
              ),
            },
          ],
        };
      },
    }),
    defineTool({
      name: "reminders_cancel",
      description: "Cancel a one-time reminder before it is delivered.",
      parameters: Type.Object({ reminder }),
      replay: "safe",
      execute: async ({ reminder: id }, api) => {
        const { actor, realm } = await actorFor(api.conversationId);
        return {
          output: [
            {
              type: "text",
              text: describe(reminders.cancel(workspaceId, actor, realm, id)),
            },
          ],
        };
      },
    }),
  ];
}

function describe(reminder: Reminder): string {
  let status = "scheduled";
  if (reminder.cancelledAt) {
    status = "cancelled";
  } else if (reminder.deliveredAt) {
    status = "delivered";
  } else if (reminder.lastError) {
    status = `retrying: ${reminder.lastError}`;
  }
  return [
    `${reminder.text} (reminder ${reminder.id})`,
    `Due: ${new Intl.DateTimeFormat("en-GB", {
      timeZone: reminder.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(
      reminder.dueAt
    )} ${reminder.timeZone} (${new Date(reminder.dueAt).toISOString()})`,
    `Recipient: ${reminder.recipientId}`,
    `Thread: ${reminder.threadId}`,
    `Status: ${status}`,
  ].join("\n");
}
