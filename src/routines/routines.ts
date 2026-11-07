import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  CodemodeSandbox,
  type CodemodeTool,
  renderDeclarations,
} from "@earendil-works/pi-codemode";
import type { Integrations } from "../integrations/integrations.ts";
import type { Place, PlaceEvent, Places } from "../places/places.ts";
import type { User } from "../platform/auth.ts";
import { HttpError, notFound, required } from "../platform/errors.ts";
import type { Indexer } from "../search/search.ts";
import type { Threads } from "../threads/threads.ts";
import type { Realm, Workspaces } from "../workspaces/workspaces.ts";
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

/**
 * Work a channel does on a schedule, or each time a person arrives at or leaves a place: an optional script collects
 * what is new, and an agent acts on it.
 */
export interface Routine {
  readonly id: string;
  readonly channelId: string;
  readonly name: string;
  /** A cron expression in the server's time zone; null for a routine at a place. */
  readonly schedule: string | null;
  /** The place, the event, and the person whose iPhone reports it; null for a routine on a schedule. */
  readonly place: RoutinePlace | null;
  readonly instructions: string;
  readonly script: string | null;
  readonly enabled: boolean;
  readonly nextRunAt: number | null;
  /** The thread where its agent answers; it starts at the first run that reaches the agent. */
  readonly threadId: string | null;
  readonly lastRun: RoutineRun | null;
}

export interface RoutinePlace
  extends Pick<Place, "id" | "name" | "latitude" | "longitude" | "radius"> {
  readonly event: PlaceEvent;
  /** The member whose iPhone watches the place. */
  readonly personId: string;
}

/** Where a routine waits: a place that its person and its writer both use. */
export interface RoutinePlaceInput {
  readonly id: string;
  readonly event: PlaceEvent;
  readonly personId: string;
}

/** A routine has a schedule or a place. */
export interface RoutineInput {
  readonly name: string;
  readonly schedule?: string;
  readonly place?: RoutinePlaceInput;
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
  | "allChannelsIn"
  | "allThreadsIn"
  | "channel"
  | "channelsIn"
  | "agentMember"
  | "members"
  | "requireMember"
  | "threadOf"
  | "threadsIn"
>;
export type RoutineThreads = Pick<
  Threads,
  | "instruct"
  | "messages"
  | "observe"
  | "realm"
  | "requester"
  | "startAgentThread"
>;
export type RoutineSearch = Pick<Indexer, "search">;
export type RoutinePlaces = Pick<Places, "find" | "usable">;

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
  /** '' for a routine at a place. */
  readonly schedule: string;
  readonly instructions: string;
  readonly script: string | null;
  readonly store: string;
  readonly enabled: number;
  readonly nextRunAt: number | null;
  readonly threadId: string | null;
  /** The member who last wrote its instructions or script, whose turns its runs are; `golem` when nobody did. */
  readonly createdBy: string;
  readonly placeId: string | null;
  readonly placeEvent: PlaceEvent | null;
  readonly placePersonId: string | null;
}

const ROUTINE_COLUMNS =
  "id, workspace_id AS workspaceId, channel_id AS channelId, name, schedule, instructions, script, store, enabled, next_run_at AS nextRunAt, thread_id AS threadId, created_by AS createdBy, place_id AS placeId, place_event AS placeEvent, place_person_id AS placePersonId";
const RUN_COLUMNS =
  "r.id, r.routine_id AS routineId, t.name AS routineName, r.started_at AS startedAt, r.finished_at AS finishedAt, r.outcome, r.error";

/**
 * The routines of every channel, and the scheduler that runs them; a routine at a place runs when the iPhone of its
 * person reports the event. A run first runs the routine's script in a
 * code mode sandbox; a script that finds nothing new ends the run without the agent. Otherwise, or without a script,
 * the agent of the routine's thread gets the instructions and the script's result, and answers there, or stays quiet.
 * A script that fails goes to the agent too, which repairs it.
 */
export class Routines {
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private readonly database: Database,
    private readonly workspaces: RoutineWorkspaces,
    private readonly integrations: Pick<Integrations, "tools">,
    private readonly threads: RoutineThreads,
    private readonly search: RoutineSearch,
    private readonly places: RoutinePlaces
  ) {}

  /**
   * Starts the scheduler, and finishes the runs that a stop cut off. Their agent goes on with its turn after the stop,
   * and a run waits for that turn's answer again, under the same request id, so the agent never does the work twice.
   */
  start(): void {
    const cutOff = this.database
      .query(
        "SELECT id, routine_id AS routineId, started_at AS startedAt, input, result FROM routine_run WHERE outcome = 'running'"
      )
      .all() as {
      id: string;
      routineId: string;
      startedAt: number;
      input: string | null;
      result: string | null;
    }[];
    for (const run of cutOff) {
      const [routine] = this.live(
        this.database
          .query(
            `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE id = ? AND deleted_at IS NULL`
          )
          .all(run.routineId) as RoutineRow[]
      );
      if (routine) {
        this.finish(
          run.input === null
            ? routine
            : {
                ...routine,
                ...JSON.parse(run.input),
                channelId: routine.channelId,
                threadId: routine.threadId,
              },
          run.id,
          run.startedAt,
          run.result === null ? null : JSON.parse(run.result)
        ).catch(() => {
          // The run records its own failure; this one is a database closed while it ran.
        });
      } else {
        this.database
          .query(
            "UPDATE routine_run SET outcome = 'failed', finished_at = ?, error = 'Golem stopped during the run' WHERE id = ?"
          )
          .run(Date.now(), run.id);
      }
    }
    this.timer = setInterval(() => this.tick(), TICK);
  }

  /** Stops the scheduler. A run that fails from now on, as the agents stop, stays running for the next start. */
  close(): void {
    this.closed = true;
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
    this.workspaces.channel(workspaceId, channelId, user);
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
      .run(enabled ? 1 : 0, nextRunOf(row.schedule, Date.now()), row.id);
    return this.get(routineId, user);
  }

  /** Moves the routine that runs in a thread to the channel the thread moved to, so its results stay in its channel. */
  /** Moves the routines of channel `from` to channel `to`, as when one channel merges into another. */
  moveChannel(from: string, to: string): void {
    this.database
      .query("UPDATE routine SET channel_id = ? WHERE channel_id = ?")
      .run(to, from);
  }

  moveWithThread(threadId: string, channelId: string): void {
    this.database
      .query(
        "UPDATE routine SET channel_id = ? WHERE thread_id = ? AND deleted_at IS NULL"
      )
      .run(channelId, threadId);
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

  /**
   * Runs the enabled routines that wait for the person's arrival at or departure from a place, when their iPhone reports
   * it. A routine that ran in the last 15 minutes does not run again, as a person at the edge of the circle goes in and
   * out.
   */
  atPlace(
    workspaceId: string,
    personId: string,
    placeId: string,
    event: PlaceEvent
  ): Promise<RoutineRun>[] {
    const now = Date.now();
    return this.live(
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE workspace_id = ? AND place_person_id = ? AND place_id = ? AND place_event = ? AND enabled = 1 AND deleted_at IS NULL`
        )
        .all(workspaceId, personId, placeId, event) as RoutineRow[],
      personId
    )
      .filter((row) => {
        const last = this.routineOf(row).lastRun;
        return !(
          this.running.has(row.id) ||
          (last && last.startedAt > now - MIN_ROUTINE_GAP)
        );
      })
      .map((row) => this.run(row, now));
  }

  /** The routines of a workspace in the channels `realm` sees, for its agents. */
  inWorkspace(workspaceId: string, realm: Realm): Routine[] {
    return this.live(
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at`
        )
        .all(workspaceId) as RoutineRow[],
      realm
    ).map((row) => this.routineOf(row));
  }

  /** Adds a routine to a channel for an agent of the workspace. Creating it again with the same id changes nothing. */
  create(
    workspaceId: string,
    channelId: string,
    input: RoutineInput & { readonly id: string; readonly createdBy: string }
  ): Routine {
    const name = required(input.name, "Name");
    const now = Date.now();
    const when = this.when(workspaceId, channelId, input, input.createdBy);
    this.database
      .query(
        "INSERT OR IGNORE INTO routine (id, workspace_id, channel_id, name, schedule, instructions, script, store, enabled, next_run_at, created_by, place_id, place_event, place_person_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        workspaceId,
        channelId,
        name,
        when.schedule,
        required(input.instructions, "Instructions"),
        input.script?.trim() || null,
        nextRunOf(when.schedule, now),
        input.createdBy,
        when.placeId,
        when.placeEvent,
        when.placePersonId,
        now
      );
    return this.routineOf(this.row(workspaceId, input.id));
  }

  /**
   * Changes a routine for an agent of the workspace. A new schedule moves the next run, and a schedule or a place
   * takes the place of the other. The person who writes new instructions or a new script, `changedBy`, becomes the
   * person its runs are for.
   */
  update(
    workspaceId: string,
    realm: Realm,
    routineId: string,
    changes: Partial<RoutineInput> & { readonly enabled?: boolean },
    changedBy: string
  ): Routine {
    const row = this.row(workspaceId, routineId, realm);
    const routine = this.routineOf(row);
    const createdBy =
      changes.script === undefined && changes.instructions === undefined
        ? row.createdBy
        : changedBy;
    const moved = changes.schedule !== undefined || changes.place !== undefined;
    // A new writer must use the place too; a pause or a new name keeps it.
    const when =
      moved || (row.placeId !== null && createdBy !== row.createdBy)
        ? this.when(
            workspaceId,
            row.channelId,
            moved
              ? changes
              : {
                  place: {
                    id: row.placeId!,
                    event: row.placeEvent!,
                    personId: row.placePersonId!,
                  },
                },
            createdBy
          )
        : row;
    const enabled = changes.enabled ?? routine.enabled;
    const script =
      changes.script === undefined
        ? routine.script
        : changes.script?.trim() || null;
    this.database
      .query(
        "UPDATE routine SET name = ?, schedule = ?, instructions = ?, script = ?, enabled = ?, next_run_at = ?, created_by = ?, place_id = ?, place_event = ?, place_person_id = ? WHERE id = ?"
      )
      .run(
        required(changes.name ?? routine.name, "Name"),
        when.schedule,
        required(changes.instructions ?? routine.instructions, "Instructions"),
        script,
        enabled ? 1 : 0,
        moved || changes.enabled !== undefined
          ? nextRunOf(when.schedule, Date.now())
          : routine.nextRunAt,
        createdBy,
        when.placeId,
        when.placeEvent,
        when.placePersonId,
        routineId
      );
    return this.routineOf(this.row(workspaceId, routineId));
  }

  /** Deletes a routine in a channel `realm` sees, for an agent of the workspace; its thread stays. */
  remove(workspaceId: string, realm: Realm, routineId: string): Routine {
    const routine = this.routineOf(this.row(workspaceId, routineId, realm));
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
    realm: Realm,
    script: string,
    routineId: string | undefined,
    userId: string | null
  ): Promise<ScriptResult> {
    const routine = routineId
      ? this.row(workspaceId, routineId, realm)
      : undefined;
    if (routine && routine.createdBy !== (userId ?? "golem")) {
      throw new Error(
        "Only the person who last wrote this routine can test with its stored values. Test without the routine."
      );
    }
    const running =
      routine &&
      (this.database
        .query(
          "SELECT result FROM routine_run WHERE routine_id = ? AND outcome = 'running' AND result IS NOT NULL AND (input IS NULL OR json_extract(input, '$.createdBy') = ?) ORDER BY started_at DESC LIMIT 1"
        )
        .get(routine.id, userId ?? "golem") as
        | { result: string }
        | null
        | undefined);
    const result = running
      ? (JSON.parse(running.result) as ScriptResult)
      : undefined;
    const store = result?.ok
      ? result.store
      : JSON.parse(routine?.store ?? "{}");
    return this.execute(workspaceId, script, store, userId, realm);
  }

  /** The TypeScript declarations of the tools that scripts of a workspace can call. */
  async declarations(workspaceId: string): Promise<string> {
    return renderDeclarations({
      tools: await this.scriptTools(workspaceId, null, null),
    });
  }

  /** The agent tools that create, change, test, and delete routines. */
  async tools(workspaceId: string) {
    return routineTools(
      this,
      this.workspaces,
      this.threads,
      this.places,
      workspaceId,
      await this.declarations(workspaceId)
    );
  }

  private run(routine: RoutineRow, now: number): Promise<RoutineRun> {
    const id = randomUUID();
    const startedAt = Date.now();
    this.database
      .query(
        "INSERT INTO routine_run (id, routine_id, started_at, outcome, input) VALUES (?, ?, ?, 'running', ?)"
      )
      .run(id, routine.id, startedAt, JSON.stringify(routine));
    this.database
      .query("UPDATE routine SET next_run_at = ? WHERE id = ?")
      .run(nextRunOf(routine.schedule, now + MIN_ROUTINE_GAP), routine.id);
    return this.finish(routine, id, startedAt, null);
  }

  /** Performs a run, with what its script found when a stop cut it off after the script, and records its outcome. */
  private async finish(
    routine: RoutineRow,
    id: string,
    startedAt: number,
    found: ScriptResult | null
  ): Promise<RoutineRun> {
    this.running.add(routine.id);
    let outcome: RoutineOutcome;
    let error: string | null = null;
    try {
      outcome = await this.perform(routine, id, startedAt, found);
    } catch (failure) {
      if (this.closed) {
        return {
          id,
          routineId: routine.id,
          routineName: routine.name,
          startedAt,
          finishedAt: null,
          outcome: "running",
          error: null,
        };
      }
      outcome = "failed";
      error = (failure as Error).message;
      await this.reportFailure(routine, id, error).catch((report: unknown) => {
        console.error(
          `Reporting the failed run of ${routine.name} failed`,
          report
        );
      });
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
    runId: string,
    startedAt: number,
    found: ScriptResult | null
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
      const answer = await this.tell(
        routine,
        runId,
        runTask(routine, this.placeLine(routine), null, startedAt),
        []
      );
      return answer === null ? "quiet" : "posted";
    }
    const result =
      found ??
      (await this.execute(
        routine.workspaceId,
        routine.script,
        JSON.parse(routine.store),
        routine.createdBy,
        this.realmOf(routine)
      ));
    // A run that a stop cuts off goes on with this result: a new script run could find other things.
    this.database
      .query("UPDATE routine_run SET result = ? WHERE id = ?")
      .run(JSON.stringify(result), runId);
    if (!result.ok) {
      // The run's failure notifies its person once; the agent's repair answer stays in the thread.
      await this.tell(
        routine,
        runId,
        repairTask(routine, result, startedAt),
        []
      );
      throw new Error(result.error);
    }
    // Saved only once the agent has what the script found, so a failed answer finds it again next run.
    const answer =
      result.text === null
        ? null
        : await this.tell(
            routine,
            runId,
            runTask(routine, this.placeLine(routine), result.text, startedAt),
            []
          );
    this.database
      .query("UPDATE routine SET store = ? WHERE id = ?")
      .run(JSON.stringify(result.store), routine.id);
    return answer === null ? "quiet" : "posted";
  }

  /**
   * Gives the agent of the routine's thread a task, and starts the thread on the first one. Its answer notifies
   * `notify`: a run's answer notifies nobody, as the agent calls notify when something is wrong or unusual; a repair's
   * answer, which says what does not work, notifies everyone who sees the thread.
   */
  private async tell(
    routine: RoutineRow,
    runId: string,
    text: string,
    notify: readonly string[] | "everyone"
  ): Promise<string | null> {
    return this.threads.instruct(
      await this.threadFor(routine),
      text,
      `routine:${runId}`,
      notify,
      routine.createdBy,
      "routine"
    );
  }

  /**
   * Tells the routine's person in its thread that a run failed, with a notification, every time, also when the agent
   * repaired the script or could not answer.
   */
  private async reportFailure(
    routine: RoutineRow,
    runId: string,
    error: string
  ): Promise<void> {
    if (routine.createdBy === "golem") {
      return;
    }
    await this.threads.observe(
      await this.threadFor(routine),
      `The routine "${routine.name}" failed: ${error}`,
      `routine:${runId}:failed`,
      { id: routine.createdBy, name: "", email: "" },
      true
    );
  }

  /** The routine's thread, started at its first run; read again, as an earlier step of this run may have started it. */
  private async threadFor(routine: RoutineRow) {
    const { threadId } = this.database
      .query("SELECT thread_id AS threadId FROM routine WHERE id = ?")
      .get(routine.id) as { threadId: string | null };
    const existing = this.workspaces
      .allThreadsIn(routine.workspaceId)
      .find((candidate) => candidate.id === threadId);
    if (existing) {
      return existing;
    }
    const thread = await this.threads.startAgentThread(
      routine.workspaceId,
      routine.channelId,
      routine.name
    );
    this.database
      .query("UPDATE routine SET thread_id = ? WHERE id = ?")
      .run(thread.id, routine.id);
    return thread;
  }

  /** Runs a script with the integrations of the person `userId`'s turns use, and what `realm` sees. */
  private async execute(
    workspaceId: string,
    script: string,
    store: Record<string, unknown>,
    userId: string | null,
    realm: Realm
  ): Promise<ScriptResult> {
    const sandbox = new CodemodeSandbox({
      tools: await this.scriptTools(workspaceId, userId, realm),
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

  /** The person of a routine's private channel; null for a channel every member sees. */
  private realmOf(routine: RoutineRow): Realm {
    return (
      this.workspaces
        .allChannelsIn(routine.workspaceId)
        .find((channel) => channel.id === routine.channelId)?.ownerId ?? null
    );
  }

  /**
   * What scripts call: the connectors' tools, and reading the channels, threads, and search of the workspace that
   * `realm` sees.
   */
  private async scriptTools(
    workspaceId: string,
    userId: string | null,
    realm: Realm
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
          this.workspaces.channelsIn(workspaceId, realm).map((channel) => ({
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
          // A script reads no person's own thread.
          const thread = this.workspaces
            .threadsIn(workspaceId, realm)
            .find(
              (candidate) =>
                candidate.id === threadId && candidate.ownerId === null
            );
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
          return (
            await this.search.search(workspaceId, query, limit ?? 10, realm)
          ).results;
        },
      },
    ];
  }

  /**
   * The schedule of a routine, or its place, which its person sees in Upcoming and which they and the routine's writer
   * both use.
   */
  private when(
    workspaceId: string,
    channelId: string,
    input: Pick<RoutineInput, "schedule" | "place">,
    createdBy: string
  ): {
    schedule: string;
    placeId: string | null;
    placeEvent: PlaceEvent | null;
    placePersonId: string | null;
  } {
    if ((input.schedule === undefined) === (input.place === undefined)) {
      throw new HttpError(400, "Give a routine a schedule or a place.");
    }
    if (input.schedule !== undefined) {
      nextRun(input.schedule, Date.now());
      return {
        schedule: input.schedule,
        placeId: null,
        placeEvent: null,
        placePersonId: null,
      };
    }
    const { id, event, personId } = input.place!;
    const people = createdBy === "golem" ? [personId] : [personId, createdBy];
    if (
      !(
        (event === "arrive" || event === "leave") &&
        this.workspaces
          .channelsIn(workspaceId, personId)
          .some((channel) => channel.id === channelId) &&
        people.every((userId) =>
          this.places
            .usable(workspaceId, userId)
            .some((place) => place.id === id)
        )
      )
    ) {
      throw new HttpError(
        400,
        "Give a place that the person and the writer use, arrive or leave, and a channel that the person sees."
      );
    }
    return {
      schedule: "",
      placeId: id,
      placeEvent: event,
      placePersonId: personId,
    };
  }

  /** What starts a routine at a place, for its agent; null for a routine on a schedule. */
  private placeLine(routine: RoutineRow): string | null {
    const { place } = this.routineOf(routine);
    if (!place) {
      return null;
    }
    let name = `member ${place.personId}`;
    try {
      const member = this.workspaces
        .members(routine.workspaceId, {
          id: place.personId,
          name: "",
          email: "",
        })
        .find(({ userId }) => userId === place.personId);
      name = member ? `${member.name} (member ${member.userId})` : name;
    } catch {
      // The person left the workspace; the run says their id.
    }
    return `It runs each time ${name} ${place.event === "arrive" ? "arrives at" : "leaves"} ${place.name}, as their iPhone tells Golem, and when someone runs it by hand.`;
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
      schedule: row.placeId ? null : row.schedule,
      place: this.placeOf(row),
      instructions: row.instructions,
      script: row.script,
      enabled: row.enabled === 1,
      nextRunAt: row.enabled === 1 ? row.nextRunAt : null,
      threadId: row.threadId,
      lastRun,
    };
  }

  /** The place of a routine at a place, also a removed one: a routine keeps the place it was made for. */
  private placeOf(row: RoutineRow): RoutinePlace | null {
    const place = row.placeId
      ? this.places.find(row.workspaceId, row.placeId)
      : null;
    return place
      ? {
          id: place.id,
          name: place.name,
          latitude: place.latitude,
          longitude: place.longitude,
          radius: place.radius,
          event: row.placeEvent!,
          personId: row.placePersonId!,
        }
      : null;
  }

  /** Nothing is removed: a deleted routine stays, hidden, and never runs again. */
  private softDelete(routineId: string): void {
    this.database
      .query("UPDATE routine SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), routineId);
  }

  /**
   * The routines among `rows` whose channel is not deleted, and that `realm` sees when given; a deleted channel's
   * routines rest with it.
   */
  private live(rows: RoutineRow[], realm?: Realm): RoutineRow[] {
    const channels = new Map<string, Set<string>>();
    return rows.filter((row) => {
      let ids = channels.get(row.workspaceId);
      if (!ids) {
        ids = new Set(
          (realm === undefined
            ? this.workspaces.allChannelsIn(row.workspaceId)
            : this.workspaces.channelsIn(row.workspaceId, realm)
          ).map((channel) => channel.id)
        );
        channels.set(row.workspaceId, ids);
      }
      return ids.has(row.channelId);
    });
  }

  private row(
    workspaceId: string,
    routineId: string,
    realm?: Realm
  ): RoutineRow {
    const [row] = this.live(
      this.database
        .query(
          `SELECT ${ROUTINE_COLUMNS} FROM routine WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
        )
        .all(routineId, workspaceId) as RoutineRow[],
      realm
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
    this.workspaces.channel(row.workspaceId, row.channelId, user);
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

/** The next run of a routine on a schedule; null for a routine at a place, which waits for its event. */
function nextRunOf(schedule: string, now: number): number | null {
  return schedule === "" ? null : nextRun(schedule, now);
}

function runTask(
  routine: RoutineRow,
  place: string | null,
  found: string | null,
  startedAt: number
): string {
  return [
    `The routine "${routine.name}" (routine ${routine.id}) runs now, at ${localTime(startedAt)}.`,
    place ?? "",
    `Its instructions: ${routine.instructions}`,
    found === null ? "" : `What its script found:\n${found}`,
    `Do what the instructions say, with your tools. Write your answer for the people in this channel; it stays in this thread and notifies nobody. Call notify only when something is wrong or not usual, such as a source or a connector that fails, or when the instructions ask you to alert people. If nothing needs anyone's attention, answer with only QUIET.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function repairTask(
  routine: RoutineRow,
  result: { readonly error: string; readonly text: string },
  startedAt: number
): string {
  return [
    `The script of the routine "${routine.name}" (routine ${routine.id}) failed at ${localTime(startedAt)}: ${result.error}`,
    result.text ? `It printed:\n${cut(result.text)}` : "",
    `The script:\n${routine.script}`,
    "Find the cause. If the script is wrong, fix it: run the new script with routines_test_script, then save it with routines_update. Say in plain words what did not work and what you did; when something outside the script fails, such as a connector or a website, say what the people can do. Golem notifies the routine's person of the failure itself.",
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
