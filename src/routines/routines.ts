import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  CodemodeSandbox,
  type CodemodeTool,
  renderDeclarations,
} from "@earendil-works/pi-codemode";
import type { Integrations } from "../integrations/integrations.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import type { Indexer } from "../search/search.ts";
import type { Threads } from "../threads/threads.ts";
import type { Workspaces } from "../workspaces/workspaces.ts";
import { routineTools } from "./tools.ts";

export type RoutineOutcome = "running" | "quiet" | "posted" | "failed";

export interface RoutineRun {
  readonly id: string;
  readonly routineId: string;
  readonly routineName: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly outcome: RoutineOutcome;
  readonly error: string | null;
}

/** Work a channel does on a schedule: an optional script collects what is new, and an agent acts on it. */
export interface Routine {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  /** A cron expression in the server's time zone. */
  readonly schedule: string;
  readonly instructions: string;
  readonly script: string | null;
  readonly enabled: boolean;
  readonly nextRunAt: number | null;
  /** The thread where its agent answers; it starts at the first run that reaches the agent. */
  readonly threadId: string | null;
  readonly lastRun: RoutineRun | null;
}

export interface RoutineInput {
  readonly name: string;
  readonly schedule: string;
  readonly instructions: string;
  readonly script?: string | null;
}

/** What a script run gave: the text for the agent, or `null` when it found nothing new. */
export type ScriptResult =
  | {
      readonly ok: true;
      readonly text: string | null;
      readonly store: Record<string, unknown>;
    }
  | { readonly ok: false; readonly error: string; readonly text: string };

export type RoutineWorkspaces = Pick<
  Workspaces,
  "channelsIn" | "requireMember" | "threadsIn"
>;
export type RoutineThreads = Pick<
  Threads,
  "instruct" | "messages" | "requester" | "startAgentThread"
>;
export type RoutineSearch = Pick<Indexer, "search">;

/** How often the scheduler looks for routines that are due. */
const TICK = 30_000;
/** The longest a script may run, with its tool calls. */
const SCRIPT_TIMEOUT = 5 * 60_000;
/** A routine runs at most this often, whatever its schedule says. */
const MIN_ROUTINE_GAP = 15 * 60_000;
/** The most of a script's result the agent gets. */
const MAX_RESULT = 50_000;
/** Runs the channel details page shows. */
const RECENT_RUNS = 20;

interface RoutineRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly name: string;
  readonly schedule: string;
  readonly instructions: string;
  readonly script: string | null;
  readonly store: string;
  readonly enabled: number;
  readonly nextRunAt: number | null;
  readonly threadId: string | null;
  /** The member who last wrote its instructions or script, whose turns its runs are; `golem` when nobody did. */
  readonly createdBy: string;
}

const ROUTINE_COLUMNS =
  "id, workspace_id AS workspaceId, channel_id AS channelId, name, schedule, instructions, script, store, enabled, next_run_at AS nextRunAt, thread_id AS threadId, created_by AS createdBy";
const RUN_COLUMNS =
  "r.id, r.routine_id AS routineId, t.name AS routineName, r.started_at AS startedAt, r.finished_at AS finishedAt, r.outcome, r.error";

/**
 * The routines of every channel, and the scheduler that runs them. A run first runs the routine's script in a
 * code mode sandbox; a script that finds nothing new ends the run without the agent. Otherwise, or without a script,
 * the agent of the routine's thread gets the instructions and the script's result, and answers there, or stays quiet.
 * A script that fails goes to the agent too, which repairs it.
 */
export class Routines {
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly database: Database,
    private readonly workspaces: RoutineWorkspaces,
    private readonly integrations: Pick<Integrations, "tools">,
    private readonly threads: RoutineThreads,
    private readonly search: RoutineSearch
  ) {}

  /** Starts the scheduler. A run that a stop cut off counts as failed. */
  start(): void {
    this.database
      .query(
        "UPDATE routine_run SET outcome = 'failed', finished_at = ?, error = 'Golem stopped during the run' WHERE outcome = 'running'"
      )
      .run(Date.now());
    this.timer = setInterval(() => this.tick(), TICK);
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Starts each enabled routine that is due, once, however many runs it missed. */
  tick(now = Date.now()): Promise<RoutineRun>[] {
    const due = this.database
      .query(
        `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE enabled = 1 AND next_run_at <= ? AND deleted_at IS NULL`
      )
      .all(now) as RoutineRow[];
    return this.live(due)
      .filter((routine) => !this.running.has(routine.id))
      .map((routine) => this.run(routine, now));
  }

  /** The routines of a channel and their newest runs. */
  inChannel(
    workspaceId: string,
    channelId: string,
    user: User
  ): { routines: Routine[]; runs: RoutineRun[] } {
    this.workspaces.requireMember(workspaceId, user);
    if (
      !this.workspaces
        .channelsIn(workspaceId)
        .some((channel) => channel.id === channelId)
    ) {
      throw notFound();
    }
    const rows = this.database
      .query(
        `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE channel_id = ? AND deleted_at IS NULL ORDER BY created_at`
      )
      .all(channelId) as RoutineRow[];
    const runs = this.database
      .query(
        `SELECT ${RUN_COLUMNS} FROM routine_run r JOIN routine t ON t.id = r.routine_id WHERE t.channel_id = ? AND t.deleted_at IS NULL ORDER BY r.started_at DESC LIMIT ${RECENT_RUNS}`
      )
      .all(channelId) as RoutineRun[];
    return { routines: rows.map((row) => this.routineOf(row)), runs };
  }

  /** A routine of a workspace that `user` is a member of. */
  get(routineId: string, user: User): Routine {
    return this.routineOf(this.rowFor(routineId, user));
  }

  setEnabled(routineId: string, user: User, enabled: boolean): Routine {
    const row = this.rowFor(routineId, user);
    this.database
      .query("UPDATE routine SET enabled = ?, next_run_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, nextRun(row.schedule, Date.now()), row.id);
    return this.get(routineId, user);
  }

  delete(routineId: string, user: User): void {
    this.softDelete(this.rowFor(routineId, user).id);
  }

  /** Runs a routine now, in the background; its run shows on the channel's details page. */
  runNow(routineId: string, user: User): void {
    const row = this.rowFor(routineId, user);
    if (this.running.has(row.id)) {
      throw new HttpError(409, `${row.name} is running`);
    }
    this.run(row, Date.now()).catch(() => {
      // The run records its own failure; this one is a database closed while it ran.
    });
  }

  /** The routines of a workspace, for its agents. */
  inWorkspace(workspaceId: string): Routine[] {
    return (
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at`
        )
        .all(workspaceId) as RoutineRow[]
    )
      .filter((row) => this.live([row]).length > 0)
      .map((row) => this.routineOf(row));
  }

  /** Adds a routine to a channel for an agent of the workspace. Creating it again with the same id changes nothing. */
  create(
    workspaceId: string,
    channelId: string,
    input: RoutineInput & { readonly id: string; readonly createdBy: string }
  ): Routine {
    const name = required(input.name, "Name");
    const now = Date.now();
    this.database
      .query(
        "INSERT OR IGNORE INTO routine (id, workspace_id, channel_id, name, schedule, instructions, script, store, enabled, next_run_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?, ?)"
      )
      .run(
        input.id,
        workspaceId,
        channelId,
        name,
        input.schedule,
        required(input.instructions, "Instructions"),
        input.script?.trim() || null,
        nextRun(input.schedule, now),
        input.createdBy,
        now
      );
    return this.routineIn(workspaceId, input.id);
  }

  /**
   * Changes a routine for an agent of the workspace. A new schedule moves the next run. The person who writes new
   * instructions or a new script, `changedBy`, becomes the person its runs are for.
   */
  update(
    workspaceId: string,
    routineId: string,
    changes: Partial<RoutineInput> & { readonly enabled?: boolean },
    changedBy: string
  ): Routine {
    const row = this.row(workspaceId, routineId);
    const routine = this.routineOf(row);
    const schedule = changes.schedule ?? routine.schedule;
    const enabled = changes.enabled ?? routine.enabled;
    const script =
      changes.script === undefined
        ? routine.script
        : changes.script?.trim() || null;
    this.database
      .query(
        "UPDATE routine SET name = ?, schedule = ?, instructions = ?, script = ?, enabled = ?, next_run_at = ?, created_by = ? WHERE id = ?"
      )
      .run(
        required(changes.name ?? routine.name, "Name"),
        schedule,
        required(changes.instructions ?? routine.instructions, "Instructions"),
        script,
        enabled ? 1 : 0,
        changes.schedule === undefined && changes.enabled === undefined
          ? routine.nextRunAt
          : nextRun(schedule, Date.now()),
        changes.script === undefined && changes.instructions === undefined
          ? row.createdBy
          : changedBy,
        routineId
      );
    return this.routineIn(workspaceId, routineId);
  }

  /** Deletes a routine for an agent of the workspace; its thread stays. */
  remove(workspaceId: string, routineId: string): Routine {
    const routine = this.routineIn(workspaceId, routineId);
    this.softDelete(routineId);
    return routine;
  }

  /**
   * Runs a script once, as a routine run would, with the values a routine stored and the integrations of the person
   * who tests it; nothing is saved. Only the routine's own person tests with its stored values, which their
   * integrations filled.
   */
  async test(
    workspaceId: string,
    script: string,
    routineId: string | undefined,
    userId: string | null
  ): Promise<ScriptResult> {
    const routine = routineId ? this.row(workspaceId, routineId) : undefined;
    if (routine && routine.createdBy !== (userId ?? "golem")) {
      throw new Error(
        "Only the person who last wrote this routine can test with its stored values. Test without the routine."
      );
    }
    const store = routine ? JSON.parse(routine.store) : {};
    return this.execute(workspaceId, script, store, userId);
  }

  /** The TypeScript declarations of the tools that scripts of a workspace can call. */
  async declarations(workspaceId: string): Promise<string> {
    return renderDeclarations({
      tools: await this.scriptTools(workspaceId, null),
    });
  }

  /** The agent tools that create, change, test, and delete routines. */
  async tools(workspaceId: string) {
    return routineTools(
      this,
      this.workspaces,
      this.threads,
      workspaceId,
      await this.declarations(workspaceId)
    );
  }

  private async run(routine: RoutineRow, now: number): Promise<RoutineRun> {
    this.running.add(routine.id);
    const id = randomUUID();
    const startedAt = Date.now();
    this.database
      .query(
        "INSERT INTO routine_run (id, routine_id, started_at, outcome) VALUES (?, ?, ?, 'running')"
      )
      .run(id, routine.id, startedAt);
    this.database
      .query("UPDATE routine SET next_run_at = ? WHERE id = ?")
      .run(nextRun(routine.schedule, now + MIN_ROUTINE_GAP), routine.id);
    let outcome: RoutineOutcome;
    let error: string | null = null;
    try {
      outcome = await this.perform(routine, id);
    } catch (failure) {
      outcome = "failed";
      error = (failure as Error).message;
    } finally {
      this.running.delete(routine.id);
    }
    const finishedAt = Date.now();
    this.database
      .query(
        "UPDATE routine_run SET outcome = ?, error = ?, finished_at = ? WHERE id = ?"
      )
      .run(outcome, error, finishedAt, id);
    return {
      id,
      routineId: routine.id,
      routineName: routine.name,
      startedAt,
      finishedAt,
      outcome,
      error,
    };
  }

  private async perform(
    routine: RoutineRow,
    runId: string
  ): Promise<"quiet" | "posted"> {
    if (routine.createdBy !== "golem") {
      try {
        this.workspaces.requireMember(routine.workspaceId, {
          id: routine.createdBy,
          name: "",
          email: "",
        });
      } catch (error) {
        throw new Error(
          "Its person is no longer a member; change it to run it as yourself.",
          { cause: error }
        );
      }
    }
    if (!routine.script) {
      const answer = await this.tell(routine, runId, runTask(routine, null));
      return answer === null ? "quiet" : "posted";
    }
    const result = await this.execute(
      routine.workspaceId,
      routine.script,
      JSON.parse(routine.store),
      routine.createdBy
    );
    if (!result.ok) {
      await this.tell(routine, runId, repairTask(routine, result));
      throw new Error(result.error);
    }
    // Saved only once the agent has what the script found, so a failed answer finds it again next run.
    const answer =
      result.text === null
        ? null
        : await this.tell(routine, runId, runTask(routine, result.text));
    this.database
      .query("UPDATE routine SET store = ? WHERE id = ?")
      .run(JSON.stringify(result.store), routine.id);
    return answer === null ? "quiet" : "posted";
  }

  /** Gives the agent of the routine's thread a task, and starts the thread on the first one. */
  private async tell(
    routine: RoutineRow,
    runId: string,
    text: string
  ): Promise<string | null> {
    let thread = this.workspaces
      .threadsIn(routine.workspaceId)
      .find((candidate) => candidate.id === routine.threadId);
    if (!thread) {
      thread = await this.threads.startAgentThread(
        routine.workspaceId,
        routine.channelId,
        routine.name
      );
      this.database
        .query("UPDATE routine SET thread_id = ? WHERE id = ?")
        .run(thread.id, routine.id);
    }
    return this.threads.instruct(
      thread,
      text,
      `routine:${runId}`,
      "everyone",
      routine.createdBy
    );
  }

  /** Runs a script with the integrations of the person `userId`'s turns use. */
  private async execute(
    workspaceId: string,
    script: string,
    store: Record<string, unknown>,
    userId: string | null
  ): Promise<ScriptResult> {
    const sandbox = new CodemodeSandbox({
      tools: await this.scriptTools(workspaceId, userId),
      timeoutMs: SCRIPT_TIMEOUT,
      memoryLimitBytes: 256 * 1024 * 1024,
    });
    try {
      const result = await sandbox.execute(script, { store });
      const printed = result.output
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      if (!result.ok) {
        return {
          ok: false,
          error: `${result.error.name ?? result.error.kind}: ${result.error.message}`,
          text: printed,
        };
      }
      for (const key of result.storeWrites.delete) {
        delete store[key];
      }
      Object.assign(store, result.storeWrites.set);
      const { value } = result;
      const nothing =
        value === undefined ||
        value === null ||
        (Array.isArray(value) && value.length === 0);
      const text = [printed, nothing ? "" : JSON.stringify(value, null, 2)]
        .filter(Boolean)
        .join("\n");
      return {
        ok: true,
        text: text ? cut(text) : null,
        store,
      };
    } finally {
      await sandbox.close();
    }
  }

  /** What scripts call: the connectors' tools, and reading the workspace's channels, threads, and search. */
  private async scriptTools(
    workspaceId: string,
    userId: string | null
  ): Promise<CodemodeTool[]> {
    const connectors = (await this.integrations.tools(workspaceId)).map(
      (tool): CodemodeTool => ({
        name: tool.name,
        description: tool.description,
        // A TypeBox schema is a JSON schema.
        inputSchema: { ...tool.parameters },
        execute: (args, { signal }) => tool.execute(args, { userId, signal }),
      })
    );
    return [
      ...connectors,
      {
        name: "list_channels",
        description:
          "The channels of the workspace with their summaries and threads, newest thread first.",
        inputSchema: { type: "object", properties: {} },
        execute: () =>
          this.workspaces.channelsIn(workspaceId).map((channel) => ({
            name: channel.name,
            summary: channel.summary,
            threads: channel.threads.map(({ id, title, updatedAt }) => ({
              id,
              title,
              updatedAt,
            })),
          })),
      },
      {
        name: "read_thread",
        description:
          "The newest messages of a thread, oldest first. `time` is in Unix milliseconds.",
        inputSchema: {
          type: "object",
          properties: {
            thread: { type: "string", description: "The thread id" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
          required: ["thread"],
        },
        execute: async (args) => {
          const { thread: threadId, limit } = args as {
            thread: string;
            limit?: number;
          };
          const thread = this.workspaces
            .threadsIn(workspaceId)
            .find((candidate) => candidate.id === threadId);
          if (!thread) {
            throw new Error(`There is no thread ${threadId}.`);
          }
          const { messages } = await this.threads.messages(thread);
          return messages
            .filter((message) => !message.streaming)
            .slice(-(limit ?? 50))
            .map(({ author, text, time }) => ({ author, text, time }));
        },
      },
      {
        name: "search",
        description:
          "Search the workspace: threads, notes, files, and captured mail or chats.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
          required: ["query"],
        },
        execute: async (args) => {
          const { query, limit } = args as { query: string; limit?: number };
          return (await this.search.search(workspaceId, query, limit ?? 10))
            .results;
        },
      },
    ];
  }

  private routineOf(row: RoutineRow): Routine {
    const lastRun = this.database
      .query(
        `SELECT ${RUN_COLUMNS} FROM routine_run r JOIN routine t ON t.id = r.routine_id WHERE r.routine_id = ? ORDER BY r.started_at DESC LIMIT 1`
      )
      .get(row.id) as RoutineRun | null;
    return {
      id: row.id,
      channelId: row.channelId,
      name: row.name,
      schedule: row.schedule,
      instructions: row.instructions,
      script: row.script,
      enabled: row.enabled === 1,
      nextRunAt: row.enabled === 1 ? row.nextRunAt : null,
      threadId: row.threadId,
      lastRun,
    };
  }

  private routineIn(workspaceId: string, routineId: string): Routine {
    return this.routineOf(this.row(workspaceId, routineId));
  }

  /** Nothing is removed: a deleted routine stays, hidden, and never runs again. */
  private softDelete(routineId: string): void {
    this.database
      .query("UPDATE routine SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), routineId);
  }

  /** The routines among `rows` whose channel is not deleted; a deleted channel's routines rest with it. */
  private live(rows: RoutineRow[]): RoutineRow[] {
    const channels = new Map<string, Set<string>>();
    return rows.filter((row) => {
      let ids = channels.get(row.workspaceId);
      if (!ids) {
        ids = new Set(
          this.workspaces
            .channelsIn(row.workspaceId)
            .map((channel) => channel.id)
        );
        channels.set(row.workspaceId, ids);
      }
      return ids.has(row.channelId);
    });
  }

  private row(workspaceId: string, routineId: string): RoutineRow {
    const [row] = this.live(
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
        )
        .all(routineId, workspaceId) as RoutineRow[]
    );
    if (!row) {
      throw new Error(
        `There is no routine ${routineId}. routines_list shows the routines.`
      );
    }
    return row;
  }

  private rowFor(routineId: string, user: User): RoutineRow {
    const [row] = this.live(
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE id = ? AND deleted_at IS NULL`
        )
        .all(routineId) as RoutineRow[]
    );
    if (!row) {
      throw notFound();
    }
    this.workspaces.requireMember(row.workspaceId, user);
    return row;
  }
}

/** The next time after `now` that a cron expression names; throws for one that is not valid. */
export function nextRun(schedule: string, now: number): number | null {
  try {
    return Bun.cron.parse(schedule, now)?.getTime() ?? null;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: HttpError takes the cause as its third argument.
    throw new HttpError(
      400,
      `The schedule "${schedule}" is not a cron expression: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

function runTask(routine: RoutineRow, found: string | null): string {
  return [
    `The routine "${routine.name}" (routine ${routine.id}) runs now, at ${localTime(Date.now())}.`,
    `Its instructions: ${routine.instructions}`,
    found === null ? "" : `What its script found:\n${found}`,
    `Do what the instructions say, with your tools. Write your answer for the people in this channel. If nothing needs anyone's attention, answer with only QUIET.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function repairTask(
  routine: RoutineRow,
  result: { readonly error: string; readonly text: string }
): string {
  return [
    `The script of the routine "${routine.name}" (routine ${routine.id}) failed at ${localTime(Date.now())}: ${result.error}`,
    result.text ? `It printed:\n${cut(result.text)}` : "",
    `The script:\n${routine.script}`,
    "Find the cause. If the script is wrong, fix it: run the new script with routines_test_script, then save it with routines_update. If something outside the script fails, such as a connector or a website, tell the people in this channel in plain words what does not work. If you fixed the script, answer with only QUIET.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function cut(text: string): string {
  return text.length > MAX_RESULT
    ? `${text.slice(0, MAX_RESULT)}\n[The rest of the ${text.length} characters is cut.]`
    : text;
}

function localTime(milliseconds: number): string {
  return new Date(milliseconds).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
