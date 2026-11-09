import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { randomUUIDv5 } from "bun";
import type { Chats } from "../chats/chats.ts";
import type { Places } from "../places/places.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import type { Reminder, ReminderInput, Reminders } from "./reminders.ts";

/** Agent tools for the one-time reminders of a workspace, at a time or at a place. */
export function reminderTools(
  reminders: Reminders,
  workspaces: Pick<Workspaces, "agentMember" | "members" | "chatOf">,
  chats: Pick<Chats, "realm" | "requester">,
  places: Pick<Places, "usable">,
  workspaceId: string
) {
  const at = Type.Optional(
    Type.String({
      description:
        "The local date and time with its UTC offset, such as 2026-11-01T09:00:00+01:00; leave it out for a place",
    })
  );
  const place = Type.Optional(
    Type.String({
      description:
        "The name of a place from reminders_places, in place of a time",
    })
  );
  const from = Type.Optional(
    Type.String({
      description:
        "For a place: not before this local date and time with its UTC offset, such as when the person arrives at work on Monday; if they are already there then, it fires at once",
    })
  );
  const until = Type.Optional(
    Type.String({
      description:
        "For a place: the latest local date and time with its UTC offset; if the person has not arrived or left by then, it fires then anyway",
    })
  );
  const event = Type.Optional(
    Type.Union([Type.Literal("arrive"), Type.Literal("leave")], {
      description: "For a place: remind when the person arrives or leaves",
    })
  );
  const timeZone = Type.String({
    description: "IANA time zone of the recipient, such as Europe/Prague",
  });
  const text = Type.String({ description: "What to remind the person about" });
  const reminder = Type.String({ description: "The reminder id" });
  const recipient = Type.Optional(
    Type.String({ description: "Name of a member of this workspace" })
  );
  const actorFor = async (
    conversationId: Parameters<Chats["requester"]>[1]
  ) => {
    const asker = await chats.requester(workspaceId, conversationId);
    return {
      asker,
      actor: asker ?? workspaces.agentMember(workspaceId),
      realm: await chats.realm(workspaceId, conversationId),
    };
  };
  /** The member named `recipient`, else the person who asks. */
  const recipientOf = (
    actor: Awaited<ReturnType<typeof actorFor>>["actor"],
    askerId: string | null,
    name: string | undefined
  ): string => {
    const members = workspaces.members(workspaceId, actor);
    const matches = name
      ? members.filter(
          (member) => member.name.toLowerCase() === name.toLowerCase()
        )
      : members.filter((member) => member.userId === askerId);
    if (matches.length !== 1) {
      throw new Error(
        "Name exactly one member of this workspace as the recipient."
      );
    }
    return matches[0]!.userId;
  };
  /** The places of a reminder: those that the recipient and the asker both use. */
  const placesFor = (recipientId: string, askerId: string | null) => {
    const asker = new Set(
      places.usable(workspaceId, askerId ?? recipientId).map(({ id }) => id)
    );
    return places
      .usable(workspaceId, recipientId)
      .filter(({ id }) => asker.has(id));
  };
  /** The time or the place of a reminder. */
  const whenOf = (
    args: {
      at?: string;
      place?: string;
      event?: "arrive" | "leave";
      from?: string;
      until?: string;
    },
    recipientId: string,
    askerId: string | null
  ): Pick<ReminderInput, "at" | "place"> => {
    if (args.place === undefined) {
      if (args.from !== undefined || args.until !== undefined) {
        throw new Error("from and until go with a place; a time is exact.");
      }
      return { at: args.at };
    }
    const known = placesFor(recipientId, askerId);
    const found = known.find(
      ({ name }) => name.toLowerCase() === args.place!.toLowerCase()
    );
    if (!found) {
      throw new Error(
        known.length
          ? `Name one of these places: ${known.map(({ name }) => name).join(", ")}.`
          : "There is no place for this reminder. A person adds places in Settings and shares one, so other members use it."
      );
    }
    return {
      place: {
        id: found.id,
        event: args.event ?? "arrive",
        ...(args.from ? { from: args.from } : {}),
        ...(args.until ? { until: args.until } : {}),
      },
    };
  };

  return [
    defineTool({
      name: "reminders_create",
      description:
        "Schedule one reminder for one exact future date and time, or for when the recipient arrives at or leaves a place; their iPhone tells Golem. A place reminder can have a window: from, such as 'when I get to work on Monday', and until, when it fires anyway, such as 'next time I am at the shop this week'. 'At 18:00 if I am home, else when I get home' is arrive home from 18:00. Make one reminder for one request, with no helper reminders or chats. Use a routine for repeated work. Give the recipient's name when it is not the person who asked. Confirm the saved time or place in your answer.",
      parameters: Type.Object({
        text,
        at,
        place,
        from,
        until,
        event,
        timeZone,
        recipient,
      }),
      replay: "safe",
      execute: async (args, api) => {
        const { actor, asker } = await actorFor(api.conversationId);
        const source = workspaces.chatOf(workspaceId, api.conversationId);
        if (!source) {
          throw new Error("This tool works only in a chat.");
        }
        const recipientId = recipientOf(
          actor,
          asker?.id ?? null,
          args.recipient
        );
        const created = reminders.create(
          workspaceId,
          actor,
          source.id,
          recipientId,
          {
            text: args.text,
            timeZone: args.timeZone,
            ...whenOf(args, recipientId, asker?.id ?? null),
            createdBy: asker?.id ?? null,
            id: randomUUIDv5(`golem:${workspaceId}:${api.taskId}`, "url"),
          }
        );
        return { output: [{ type: "text", text: describe(created) }] };
      },
    }),
    defineTool({
      name: "reminders_places",
      description:
        "The names of the places that a reminder for the recipient can name, from the Settings of the people.",
      parameters: Type.Object({ recipient }),
      replay: "safe",
      execute: async (args, api) => {
        const { actor, asker } = await actorFor(api.conversationId);
        const recipientId = recipientOf(
          actor,
          asker?.id ?? null,
          args.recipient
        );
        const names = placesFor(recipientId, asker?.id ?? null).map(
          ({ name }) => name
        );
        return {
          output: [
            {
              type: "text",
              text:
                names.join("\n") ||
                "No places. A person adds places in Settings and shares one, so other members use it.",
            },
          ],
        };
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
      description:
        "Change a pending one-time reminder: its text, and its time or place with its window.",
      parameters: Type.Object({
        reminder,
        text,
        at,
        place,
        event,
        from,
        until,
        timeZone,
      }),
      replay: "safe",
      execute: async ({ reminder: id, ...input }, api) => {
        const { actor, asker, realm } = await actorFor(api.conversationId);
        const { recipientId } = reminders.get(workspaceId, actor, realm, id);
        return {
          output: [
            {
              type: "text",
              text: describe(
                reminders.update(workspaceId, actor, realm, id, {
                  text: input.text,
                  timeZone: input.timeZone,
                  ...whenOf(input, recipientId, asker?.id ?? null),
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
  const { place } = reminder;
  return [
    `${reminder.text} (reminder ${reminder.id})`,
    place
      ? `When: the recipient ${place.event === "arrive" ? "arrives at" : "leaves"} ${place.name}${reminder.notBefore === null ? "" : `, not before ${local(reminder.notBefore, reminder.timeZone)}`}${reminder.notAfter === null ? "" : `, at ${local(reminder.notAfter, reminder.timeZone)} at the latest`}`
      : `Due: ${local(reminder.dueAt, reminder.timeZone)} ${reminder.timeZone} (${new Date(reminder.dueAt).toISOString()})`,
    `Recipient: ${reminder.recipientId}`,
    `Chat: ${reminder.chatId}`,
    `Status: ${status}`,
  ].join("\n");
}

/** A time as the recipient reads it in their time zone. */
function local(time: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(time);
}
