import {
  badge,
  button,
  empty,
  menu,
  pageContent,
  pageSection,
  settingsCard,
  settingsRow,
  switchForm,
} from "../platform/ui/components.ts";
import { icon } from "../platform/ui/icons.ts";
import { markdown } from "../platform/ui/markdown.ts";
import type { Brief } from "../threads/threads.ts";
import { type ShellContext, shell } from "../workspaces/shell.ts";
import type { Channel } from "../workspaces/workspaces.ts";
import type { Routine, RoutineOutcome, RoutineRun } from "./routines.ts";

const escapeHtml = Bun.escapeHTML;

const OUTCOMES: Record<
  RoutineOutcome,
  { label: string; tone?: "accent" | "success" | "danger" }
> = {
  running: { label: "Running", tone: "accent" },
  quiet: { label: "Quiet" },
  posted: { label: "Posted", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

/**
 * A channel's summary and brief, its routines, and their newest runs. People create routines by asking an agent; the
 * model writes the summary and the brief from the channel's threads.
 */
export function channelDetailsPage(
  context: ShellContext,
  channel: Channel,
  brief: Brief | null,
  routines: readonly Routine[],
  runs: readonly RoutineRun[]
): string {
  const base = `/w/${context.workspace!.id}`;
  const channelBase = `${base}/c/${channel.id}`;
  const summary = channel.summary
    ? pageSection(
        "Summary",
        `<p class="page-text">${escapeHtml(channel.summary)}</p>`
      )
    : "";
  const briefSection = brief
    ? pageSection(
        "Brief",
        `<div class="page-text prose">${
          // The brief's headings sit under the section's own heading.
          markdown(brief.text.replace(/^#{1,2} /gm, "### "), {
            thread: (threadId) => `${base}/t/${threadId}`,
            file: (fileId) => `${base}/files/${fileId}`,
            afterThread: () => "",
          })
        }</div>`
      )
    : "";
  const routineList = routines.length
    ? settingsCard(
        routines.map((routine) => routineRow(base, channelBase, routine))
      )
    : empty("play", "No routines yet");
  const runList = runs.length
    ? settingsCard(runs.map(runRow))
    : empty("inbox", "No runs yet");
  return shell(context, {
    title: `#${channel.name}`,
    main: pageContent(
      `<span class="breadcrumb"># </span>${escapeHtml(channel.name)}`,
      summary +
        briefSection +
        pageSection("Routines", routineList) +
        pageSection("Runs", runList)
    ),
  });
}

function routineRow(
  base: string,
  channelBase: string,
  routine: Routine
): string {
  const action = `${channelBase}/routines/${routine.id}`;
  const actions = menu(
    button(`${routine.name} actions`, {
      variant: "ghost",
      icon: "more",
      size: "icon",
      attributes:
        'type="button" data-popover-trigger aria-haspopup="menu" aria-expanded="false"',
    }),
    [
      ...(routine.threadId
        ? [
            {
              kind: "link" as const,
              label: "Open thread",
              icon: "compose" as const,
              href: `${base}/t/${routine.threadId}`,
            },
          ]
        : []),
      {
        kind: "action",
        label: "Run now",
        icon: "play",
        attributes: `type="submit" form="run-${routine.id}"`,
      },
      {
        kind: "action",
        label: "Delete",
        icon: "trash",
        attributes: `type="submit" form="delete-${routine.id}"`,
      },
    ]
  );
  const forms = `<form id="run-${routine.id}" method="post" action="${action}/run" hidden></form><form id="delete-${routine.id}" method="post" action="${action}/delete" hidden></form>`;
  return settingsRow(
    routine.name,
    routine.nextRunAt === null ? "Paused" : `Next ${time(routine.nextRunAt)}`,
    `${switchForm(action, { name: "enabled", label: `Run ${routine.name}`, checked: routine.enabled })}${actions}${forms}`,
    { lead: icon("play") }
  );
}

function runRow(run: RoutineRun): string {
  const outcome = OUTCOMES[run.outcome];
  return settingsRow(
    run.routineName,
    [time(run.startedAt), run.error].filter(Boolean).join(" · "),
    badge(outcome.label, outcome.tone),
    { compact: true }
  );
}

function time(milliseconds: number): string {
  return new Date(milliseconds).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
