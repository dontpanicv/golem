import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { randomUUIDv5 } from "bun";
import type {
  Routine,
  RoutineChats,
  RoutineInput,
  RoutinePlaces,
  Routines,
  RoutineWorkspaces,
} from "./routines.ts";

const routineParameter = Type.String({ description: "The routine id" });

/**
 * The tools that let agents create, change, test, and delete the routines of their workspace. People ask in plain
 * words; the agent writes the schedule or the place, the instructions, and the script, and tests the script before it
 * saves it.
 */
export function routineTools(
  routines: Routines,
  workspaces: RoutineWorkspaces,
  chats: RoutineChats,
  places: RoutinePlaces,
  workspaceId: string,
  declarations: string
) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scriptHelp = `A script is JavaScript that runs in a sandbox at the start of every run, before an agent sees anything. It is the body of an async function: it calls tools as \`await tools.<name>(args)\`, keeps JSON values between runs with \`store(key, value)\` and \`load(key)\` (only a run that succeeds saves them), and returns what is new. It has no fetch, timers, or modules. When it returns nothing (undefined, null, or an empty array) and prints nothing, the run ends quietly, at no cost. Otherwise the agent of the routine's chat gets what it returned and printed, with the instructions. Each run starts with only its current input; use the script store and archive IDs for progress, and read earlier chat messages only when needed. During a run, routines_test_script reads the current run's proposed store; it does not commit it. Use a script for work that is the same every time, such as collecting new items since the last run; leave it out when the work needs judgement from the start. The tools scripts can call:\n${declarations}`;
  const scheduleHelp = `A cron expression in ${zone} time: minute hour day-of-month month day-of-week, such as "0 7 * * 1-5" for weekdays at 7:00. A routine runs at most every 15 minutes.`;
  const placeHelp =
    "The name of a place from the person's Settings, in place of a schedule: the routine runs each time the person arrives or leaves, as their iPhone tells Golem";
  const placeParameters = {
    place: Type.Optional(Type.String({ description: placeHelp })),
    event: Type.Optional(
      Type.Union([Type.Literal("arrive"), Type.Literal("leave")], {
        description: "For a place: run when the person arrives or leaves",
      })
    ),
    person: Type.Optional(
      Type.String({
        description:
          "For a place: the member whose arrival or departure runs it; default the person who asks",
      })
    ),
  };
  const membersOf = () =>
    workspaces.members(workspaceId, workspaces.agentMember(workspaceId));
  /** The place of a routine, which its person and the person who asks both use; undefined without one. */
  const placeOf = (
    args: { place?: string; event?: "arrive" | "leave"; person?: string },
    askerId: string | null
  ): RoutineInput["place"] => {
    if (args.place === undefined) {
      return undefined;
    }
    let personId = askerId;
    if (args.person) {
      const matches = membersOf().filter(
        (member) => member.name.toLowerCase() === args.person!.toLowerCase()
      );
      if (matches.length !== 1) {
        throw new Error("Name exactly one member of this workspace.");
      }
      personId = matches[0]!.userId;
    }
    if (personId === null) {
      throw new Error("Name the person whose arrival or departure runs it.");
    }
    const asker = new Set(
      places.usable(workspaceId, askerId ?? personId).map(({ id }) => id)
    );
    const known = places
      .usable(workspaceId, personId)
      .filter(({ id }) => asker.has(id));
    const found = known.find(
      ({ name }) => name.toLowerCase() === args.place!.toLowerCase()
    );
    if (!found) {
      throw new Error(
        known.length
          ? `Name one of these places: ${known.map(({ name }) => name).join(", ")}.`
          : "There is no place for this routine. A person adds places in Settings and shares one, so other members use it."
      );
    }
    return { id: found.id, event: args.event ?? "arrive", personId };
  };
  const describe = (routine: Routine, topic: string | undefined) =>
    describeRoutine(routine, topic, membersOf());
  const realmOf = (conversationId: ConversationId) =>
    chats.realm(workspaceId, conversationId);
  const topicOf = async (
    name: string | undefined,
    conversationId: ConversationId
  ) => {
    const topics = workspaces.topicsIn(
      workspaceId,
      await realmOf(conversationId)
    );
    if (name) {
      const topic = topics.find(
        (candidate) => candidate.name === name.replace(/^#/, "").toLowerCase()
      );
      if (!topic) {
        throw new Error(
          `There is no topic #${name}. list_topics shows the topics.`
        );
      }
      return topic;
    }
    const chat = workspaces.chatOf(workspaceId, conversationId);
    const topic = topics.find((candidate) => candidate.id === chat?.topicId);
    if (!topic) {
      throw new Error("Name the topic of the routine.");
    }
    return topic;
  };

  return [
    defineTool({
      name: "routines_list",
      description:
        "List the routines of this workspace: what runs on a schedule or at a place in each topic, and how its last run went.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api) => {
        const realm = await realmOf(api.conversationId);
        const topics = workspaces.topicsIn(workspaceId, realm);
        const text =
          routines
            .inWorkspace(workspaceId, realm)
            .map((routine) =>
              describe(
                routine,
                topics.find((topic) => topic.id === routine.topicId)?.name
              )
            )
            .join("\n\n") || "This workspace has no routines.";
        return { output: [{ type: "text", text }] };
      },
    }),

    defineTool({
      name: "routines_create",
      description: `Create a routine: work that runs in a topic on a schedule, such as checking a website every morning, or each time a person arrives at or leaves a place, such as turning on the heating when they leave work. Give a schedule or a place. Each run, the agent of the routine's own chat in the topic gets the instructions, and answers there or stays quiet. ${scriptHelp}`,
      parameters: Type.Object({
        name: Type.String({
          description: "A short name people know it by, such as School",
        }),
        schedule: Type.Optional(Type.String({ description: scheduleHelp })),
        ...placeParameters,
        instructions: Type.String({
          description:
            "What the agent does with each run, in plain words, and when it stays quiet",
        }),
        script: Type.Optional(
          Type.String({
            description: "Test it with routines_test_script first",
          })
        ),
        topic: Type.Optional(
          Type.String({
            description: "The topic name; default this chat's topic",
          })
        ),
      }),
      // The id comes from the task, so a rerun after a crash finds the routine it made before.
      replay: "safe",
      execute: async (args, api) => {
        const topic = await topicOf(args.topic, api.conversationId);
        // Its runs are the turns of the person who asked for it, with their own integrations.
        const requester = await chats.requester(
          workspaceId,
          api.conversationId
        );
        const routine = routines.create(workspaceId, topic.id, {
          name: args.name,
          schedule: args.schedule,
          place: placeOf(args, requester?.id ?? null),
          instructions: args.instructions,
          script: args.script,
          id: randomUUIDv5(`golem:${workspaceId}:${api.taskId}`, "url"),
          createdBy: requester?.id ?? "golem",
        });
        return {
          output: [
            {
              type: "text",
              text: `Created the routine.\n${describe(routine, topic.name)}`,
            },
          ],
        };
      },
    }),

    defineTool({
      name: "routines_update",
      description: `Change a routine: its name, its schedule or place (one takes the place of the other), instructions, or script, or pause it with enabled false. ${scheduleHelp}`,
      parameters: Type.Object({
        routine: routineParameter,
        name: Type.Optional(Type.String()),
        schedule: Type.Optional(Type.String()),
        ...placeParameters,
        instructions: Type.Optional(Type.String()),
        script: Type.Optional(
          Type.String({
            description:
              "The whole new script, tested with routines_test_script; an empty string removes it",
          })
        ),
        enabled: Type.Optional(Type.Boolean()),
      }),
      replay: "safe",
      execute: async (
        { routine: routineId, place, event, person, ...changes },
        api
      ) => {
        const requester = await chats.requester(
          workspaceId,
          api.conversationId
        );
        const routine = routines.update(
          workspaceId,
          await realmOf(api.conversationId),
          routineId,
          {
            ...changes,
            place: placeOf({ place, event, person }, requester?.id ?? null),
          },
          requester?.id ?? "golem"
        );
        return {
          output: [
            { type: "text", text: `Saved.\n${describe(routine, undefined)}` },
          ],
        };
      },
    }),

    defineTool({
      name: "routines_delete",
      description: "Delete a routine. Its chat stays.",
      parameters: Type.Object({ routine: routineParameter }),
      replay: "safe",
      execute: async (args, api) => {
        const routine = routines.remove(
          workspaceId,
          await realmOf(api.conversationId),
          args.routine
        );
        return {
          output: [{ type: "text", text: `Deleted ${routine.name}.` }],
        };
      },
    }),

    defineTool({
      name: "routines_test_script",
      description:
        "Run a routine script once and see what a run would give the agent, or the error. Nothing is saved, and no agent is told.",
      parameters: Type.Object({
        script: Type.String(),
        routine: Type.Optional(
          Type.String({
            description:
              "Run with the values this routine stored, as its next run would",
          })
        ),
      }),
      execute: async (args, api) => {
        const requester = await chats.requester(
          workspaceId,
          api.conversationId
        );
        const result = await routines.test(
          workspaceId,
          await realmOf(api.conversationId),
          args.script,
          args.routine,
          requester?.id ?? null
        );
        let text: string;
        if (!result.ok) {
          text = `The script failed: ${result.error}${result.text ? `\nIt printed:\n${result.text}` : ""}`;
        } else if (result.text === null) {
          text =
            "The script found nothing: a run would end quietly, without the agent.";
        } else {
          text = `The agent would get:\n${result.text}`;
        }
        return { output: [{ type: "text", text }] };
      },
    }),
  ];
}

function describeRoutine(
  routine: Routine,
  topic: string | undefined,
  members: readonly { userId: string; name: string }[]
): string {
  const { place } = routine;
  const person =
    place &&
    (members.find(({ userId }) => userId === place.personId)?.name ??
      `member ${place.personId}`);
  const last = routine.lastRun
    ? `${routine.lastRun.outcome}${routine.lastRun.error ? `: ${routine.lastRun.error}` : ""}`
    : "never ran";
  return [
    `${routine.name} (routine ${routine.id})${topic ? ` in #${topic}` : ""}`,
    `${place ? `When: each time ${person} ${place.event === "arrive" ? "arrives at" : "leaves"} ${place.name}` : `Schedule: ${routine.schedule}`}${routine.enabled ? "" : " (paused)"}`,
    `Instructions: ${routine.instructions}`,
    `Script: ${routine.script ? `\n${routine.script}` : "none"}`,
    `Last run: ${last}`,
    routine.chatId ? `Chat: [${routine.name}](chat:${routine.chatId})` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
