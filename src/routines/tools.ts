import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { randomUUIDv5 } from "bun";
import type { Routine, Routines, RoutineWorkspaces } from "./routines.ts";

const routineParameter = Type.String({ description: "The routine id" });

/**
 * The tools that let agents create, change, test, and delete the routines of their workspace. People ask in plain
 * words; the agent writes the schedule, the instructions, and the script, and tests the script before it saves it.
 */
export function routineTools(
  routines: Routines,
  workspaces: RoutineWorkspaces,
  workspaceId: string,
  declarations: string
) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scriptHelp = `A script is JavaScript that runs in a sandbox at the start of every run, before an agent sees anything. It is the body of an async function: it calls tools as \`await tools.<name>(args)\`, keeps JSON values between runs with \`store(key, value)\` and \`load(key)\` (only a run that succeeds saves them), and returns what is new. It has no fetch, timers, or modules. When it returns nothing (undefined, null, or an empty array) and prints nothing, the run ends quietly, at no cost. Otherwise the agent of the routine's thread gets what it returned and printed, with the instructions. Use a script for work that is the same every time, such as collecting new items since the last run; leave it out when the work needs judgement from the start. The tools scripts can call:\n${declarations}`;
  const scheduleHelp = `A cron expression in ${zone} time: minute hour day-of-month month day-of-week, such as "0 7 * * 1-5" for weekdays at 7:00.`;
  const channelOf = (name: string | undefined, conversationId: number) => {
    const channels = workspaces.channelsIn(workspaceId);
    if (name) {
      const channel = channels.find(
        (candidate) => candidate.name === name.replace(/^#/, "").toLowerCase()
      );
      if (!channel) {
        throw new Error(
          `There is no channel #${name}. list_channels shows the channels.`
        );
      }
      return channel;
    }
    const thread = workspaces
      .threadsIn(workspaceId)
      .find((candidate) => candidate.conversationId === conversationId);
    const channel = channels.find(
      (candidate) => candidate.id === thread?.channelId
    );
    if (!channel) {
      throw new Error("Name the channel of the routine.");
    }
    return channel;
  };

  return [
    defineTool({
      name: "routines_list",
      description:
        "List the routines of this workspace: what runs on a schedule in each channel, and how its last run went.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        const channels = workspaces.channelsIn(workspaceId);
        const text =
          routines
            .inWorkspace(workspaceId)
            .map((routine) =>
              describe(
                routine,
                channels.find((channel) => channel.id === routine.channelId)
                  ?.name
              )
            )
            .join("\n\n") || "This workspace has no routines.";
        return { output: [{ type: "text", text }] };
      },
    }),

    defineTool({
      name: "routines_create",
      description: `Create a routine: work that runs on a schedule in a channel, such as checking a website every morning. Each run, the agent of the routine's own thread in the channel gets the instructions, and answers there or stays quiet. ${scriptHelp}`,
      parameters: Type.Object({
        name: Type.String({
          description: "A short name people know it by, such as School",
        }),
        schedule: Type.String({ description: scheduleHelp }),
        instructions: Type.String({
          description:
            "What the agent does with each run, in plain words, and when it stays quiet",
        }),
        script: Type.Optional(
          Type.String({
            description: "Test it with routines_test_script first",
          })
        ),
        channel: Type.Optional(
          Type.String({
            description: "The channel name; default this thread's channel",
          })
        ),
      }),
      // The id comes from the task, so a rerun after a crash finds the routine it made before.
      replay: "safe",
      execute: async (args, api) => {
        const channel = channelOf(args.channel, api.conversationId);
        const routine = routines.create(workspaceId, channel.id, {
          ...args,
          id: randomUUIDv5(`golem:${workspaceId}:${api.taskId}`, "url"),
          createdBy: "golem",
        });
        return {
          output: [
            {
              type: "text",
              text: `Created the routine.\n${describe(routine, channel.name)}`,
            },
          ],
        };
      },
    }),

    defineTool({
      name: "routines_update",
      description: `Change a routine: its name, schedule, instructions, or script, or pause it with enabled false. ${scheduleHelp}`,
      parameters: Type.Object({
        routine: routineParameter,
        name: Type.Optional(Type.String()),
        schedule: Type.Optional(Type.String()),
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
      execute: async ({ routine: routineId, ...changes }) => {
        const routine = routines.update(workspaceId, routineId, changes);
        return {
          output: [
            { type: "text", text: `Saved.\n${describe(routine, undefined)}` },
          ],
        };
      },
    }),

    defineTool({
      name: "routines_delete",
      description: "Delete a routine. Its thread stays.",
      parameters: Type.Object({ routine: routineParameter }),
      replay: "safe",
      execute: async (args) => {
        const routine = routines.remove(workspaceId, args.routine);
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
      execute: async (args) => {
        const result = await routines.test(
          workspaceId,
          args.script,
          args.routine
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

function describe(routine: Routine, channel: string | undefined): string {
  const last = routine.lastRun
    ? `${routine.lastRun.outcome}${routine.lastRun.error ? `: ${routine.lastRun.error}` : ""}`
    : "never ran";
  return [
    `${routine.name} (routine ${routine.id})${channel ? ` in #${channel}` : ""}`,
    `Schedule: ${routine.schedule}${routine.enabled ? "" : " (paused)"}`,
    `Instructions: ${routine.instructions}`,
    `Script: ${routine.script ? `\n${routine.script}` : "none"}`,
    `Last run: ${last}`,
    routine.threadId
      ? `Thread: [${routine.name}](thread:${routine.threadId})`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
