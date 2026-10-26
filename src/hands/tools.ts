import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type PromptSection,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { HandsConnection, Machine, Reply } from "./connection.ts";
import type { Hands } from "./hands.ts";

/** The most of a command's output the agent gets: its tail. */
const MAX_OUTPUT = 16_000;
/** The most of a text file `hands_read` and `hands_edit` take. */
const MAX_TEXT = 512 * 1024;
/** How much of a file machineFile reads and fileToMachine writes at once, below the largest message hands sends. */
const FILE_PART = 8 * 1024 * 1024;

const machineParameter = Type.String({ description: "Machine name" });

/** The machines of a workspace, named in the system prompt before each request, so agents need not look them up. */
export function handsSection(hands: Hands, workspaceId: string): PromptSection {
  return {
    key: "machines",
    render: () => {
      const machines = hands.machinesIn(workspaceId);
      if (machines.length === 0) {
        return "No machines are paired with this workspace. If someone needs a shell or files on a computer, tell them to add a machine in the workspace settings.";
      }
      const lines = machines.map(
        (machine) =>
          `- ${machine.name}: ${displayOs(machine.os)} ${machine.arch}; reachable as ${hosts(machine).join(", ")}`
      );
      return [
        "Machines paired with this workspace. Every hands_* tool takes `machine`: one of these names.",
        ...lines,
        '- People may say "the Mac" or "the server": pick the machine that matches; ask only if two match.',
        "- You can use several machines in one script: `await Promise.all([...])` runs calls on different machines at the same time.",
        "- For something that must keep running while you do other things (a server, a watcher, a build), use hands_job_start, and stop it with hands_job_cancel when you are done.",
        "- When one machine has to reach another, use the other machine's address from this list, not localhost.",
        "- On a Mac, script an app with osascript when it has a scripting dictionary (Music, Finder, Mail). Start an app that is not running with `open -ga <App>` first.",
      ].join("\n");
    },
  };
}

/**
 * The agent's hands: tools that act on the workspace's machines. Commands run as supervised jobs keyed by the durable
 * tool task, so `hands_exec` is replay-safe: a rerun after a restart finds the same job instead of starting the
 * command again.
 */
export function handsTools(hands: Hands, workspaceId: string) {
  const resolve = (name: string) => machineNamed(hands, workspaceId, name);
  const use = <T>(
    machine: Machine,
    body: (connection: HandsConnection) => Promise<T>
  ) => hands.with(workspaceId, machine, body);
  // Task ids count per workspace session, and one machine can serve several workspaces.
  const jobKey = (taskId: string) => `golem-${workspaceId}-${taskId}`;

  return [
    defineTool({
      name: "hands_machines",
      description:
        "List the paired machines and whether each one is reachable right now.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        const machines = hands.machinesIn(workspaceId);
        if (machines.length === 0) {
          return text("No machines are paired.");
        }
        const lines = await Promise.all(
          machines.map(async (machine) => {
            const head = `${machine.name}: ${displayOs(machine.os)} ${machine.arch}`;
            try {
              // What the machine says now: hands may have been updated since pairing.
              const { info } = await hands.connection(workspaceId, machine);
              return `${head}, hands ${info.version ?? machine.version}: online, home ${info.home ?? "?"}`;
            } catch (error) {
              return `${head}, hands ${machine.version} when paired: unreachable (${(error as Error).message})`;
            }
          })
        );
        return text(lines.join("\n"));
      },
    }),

    defineTool({
      name: "hands_exec",
      description:
        "Run a shell command on a paired machine and return its output and exit code. It runs as a supervised job: if it is still running after timeout_s (default 60), you get its output so far and its job key, and it keeps running: wait longer with hands_job_wait, or stop it with hands_job_cancel. Pass a longer timeout_s for work you know takes longer (a build, a test run).",
      parameters: Type.Object({
        machine: machineParameter,
        command: Type.String({
          description: "Shell command, run with bash -c",
        }),
        cwd: Type.Optional(
          Type.String({
            description:
              "Working directory; ~ and relative paths start at the user's home",
          })
        ),
        timeout_s: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "How long to wait before returning (default 60)",
          })
        ),
      }),
      replay: "safe",
      execute: async (args, api, context) => {
        const machine = resolve(args.machine);
        const key = jobKey(String(api.taskId));
        return use(machine, async (connection) => {
          await startJob(connection, key, args.command, args.cwd);
          try {
            return await follow(
              connection,
              machine,
              key,
              args.timeout_s ?? 60,
              context
            );
          } catch (error) {
            if (context.abortSignal?.aborted) {
              // The run was stopped: stop the command on the machine too, its whole process group.
              await connection.request("job.cancel", { key }).catch(() => {
                // The job may have ended already.
              });
            }
            throw error;
          }
        });
      },
    }),

    defineTool({
      name: "hands_job_start",
      description:
        "Start a long-running command on a paired machine and return at once with its job key. The job keeps running after this turn ends.",
      parameters: Type.Object({
        machine: machineParameter,
        command: Type.String({
          description: "Shell command, run with bash -c",
        }),
        cwd: Type.Optional(Type.String({ description: "Working directory" })),
      }),
      replay: "safe",
      execute: async (args, api) => {
        const machine = resolve(args.machine);
        const key = jobKey(String(api.taskId));
        const started = await use(machine, (connection) =>
          startJob(connection, key, args.command, args.cwd)
        );
        return text(
          `Job ${key} is ${started.json.state ?? "running"} on ${machine.name}.`
        );
      },
    }),

    defineTool({
      name: "hands_job_wait",
      description:
        "Wait for a job on a machine to finish (up to timeout_s, default 600) and return its output and exit code.",
      parameters: Type.Object({
        machine: machineParameter,
        key: Type.String({ description: "Job key" }),
        timeout_s: Type.Optional(
          Type.Integer({ minimum: 1, description: "Seconds to wait" })
        ),
      }),
      replay: "safe",
      execute: async (args, _api, context) => {
        const machine = resolve(args.machine);
        return use(machine, (connection) =>
          follow(connection, machine, args.key, args.timeout_s ?? 600, context)
        );
      },
    }),

    defineTool({
      name: "hands_job_cancel",
      description: "Stop a job on a machine (its whole process group).",
      parameters: Type.Object({
        machine: machineParameter,
        key: Type.String({ description: "Job key" }),
      }),
      execute: async (args) => {
        const machine = resolve(args.machine);
        const status = await use(machine, (connection) =>
          connection.request("job.cancel", { key: args.key })
        );
        return text(`Job ${args.key} is ${status.json.state ?? "cancelled"}.`);
      },
    }),

    defineTool({
      name: "hands_jobs",
      description: "List recent jobs on a machine.",
      parameters: Type.Object({ machine: machineParameter }),
      replay: "safe",
      execute: async (args) => {
        const machine = resolve(args.machine);
        const { json } = await use(machine, (connection) =>
          connection.request("job.list")
        );
        const jobs = (json.jobs ?? []) as Record<string, unknown>[];
        const lines = jobs
          .slice(0, 30)
          .map(
            (job) =>
              `${job.key}  ${job.state}  exit ${job.exitCode ?? "-"}  ${job.command ?? JSON.stringify(job.argv ?? "")}`
          );
        return text(lines.join("\n") || `No jobs on ${machine.name}.`);
      },
    }),

    defineTool({
      name: "hands_read",
      description: "Read a text file on a machine (up to 512 KB).",
      parameters: Type.Object({
        machine: machineParameter,
        path: Type.String({ description: "File path; ~ is the user's home" }),
      }),
      replay: "safe",
      execute: async (args) => {
        const machine = resolve(args.machine);
        const file = await use(machine, async (connection) =>
          readText(connection, absolute(args.path, connection))
        );
        const notes = [
          file.truncated
            ? `(cut at ${MAX_TEXT / 1024} KB: the file is longer)`
            : "",
          file.text === null
            ? "(not UTF-8 text: shown with replacement characters)"
            : "",
        ].filter(Boolean);
        return text(
          [Buffer.from(file.data).toString("utf8"), ...notes].join("\n")
        );
      },
    }),

    defineTool({
      name: "hands_write",
      description:
        "Create or overwrite a text file on a machine, creating missing folders.",
      parameters: Type.Object({
        machine: machineParameter,
        path: Type.String({ description: "File path" }),
        content: Type.String({ description: "The full file content" }),
      }),
      replay: "safe",
      execute: async (args) => {
        const machine = resolve(args.machine);
        const data = Buffer.from(args.content);
        const path = await use(machine, async (connection) => {
          const target = absolute(args.path, connection);
          await connection.request(
            "write",
            { path: target, append: false },
            { payload: data }
          );
          return target;
        });
        return text(
          `Wrote ${data.length} bytes to ${path} on ${machine.name}.`
        );
      },
    }),

    defineTool({
      name: "hands_edit",
      description:
        "Replace one exact occurrence of old_text with new_text in a file on a machine.",
      parameters: Type.Object({
        machine: machineParameter,
        path: Type.String({ description: "File path" }),
        old_text: Type.String({
          description: "Text to find; must occur exactly once",
        }),
        new_text: Type.String({ description: "Replacement" }),
      }),
      execute: async (args) => {
        const machine = resolve(args.machine);
        const path = await use(machine, async (connection) => {
          const target = absolute(args.path, connection);
          // The whole file is written back, so it must have been read whole and as it is.
          const file = await readText(connection, target);
          if (file.truncated || file.text === null) {
            throw new Error(
              `${target} is over ${MAX_TEXT / 1024} KB or not UTF-8 text; edit it with a command (hands_exec) instead`
            );
          }
          const count = file.text.split(args.old_text).length - 1;
          if (count !== 1) {
            throw new Error(
              `old_text occurs ${count} times in ${target}; it must occur exactly once`
            );
          }
          await connection.request(
            "write",
            { path: target, append: false },
            {
              payload: Buffer.from(
                file.text.replace(args.old_text, () => args.new_text)
              ),
            }
          );
          return target;
        });
        return text(`Edited ${path} on ${machine.name}.`);
      },
    }),

    defineTool({
      name: "hands_list",
      description:
        "List files below a folder on a machine (respects .gitignore, at most 400 entries).",
      parameters: Type.Object({
        machine: machineParameter,
        path: Type.String({ description: "Folder path" }),
      }),
      replay: "safe",
      execute: async (args) => {
        const machine = resolve(args.machine);
        return use(machine, async (connection) => {
          const path = absolute(args.path, connection);
          const reply = await connection.request("listFiles", {
            path,
            maxEntries: 400,
          });
          return text(listing(reply, path));
        });
      },
    }),
  ];
}

/**
 * The machine `name` means: its exact name in any case, the same letters and digits ("bender 2" for bender-2), or the
 * start of only one machine's name ("Bender").
 */
export function machineNamed(
  hands: Hands,
  workspaceId: string,
  name: string
): Machine {
  const machines = hands.machinesIn(workspaceId);
  const key = (value: string) =>
    value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const wanted = key(name);
  const starting = machines.filter((candidate) =>
    key(candidate.name).startsWith(wanted)
  );
  const machine =
    machines.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase()
    ) ??
    machines.find((candidate) => wanted && key(candidate.name) === wanted) ??
    (wanted && starting.length === 1 ? starting[0] : undefined);
  if (!machine) {
    const names = machines.map((candidate) => candidate.name).join(", ");
    throw new Error(
      names
        ? `No machine named ${name}. Paired: ${names}`
        : "No machines are paired."
    );
  }
  return machine;
}

/** hands wants absolute paths: `~` and relative paths start at the user's home. */
function absolute(path: string, connection: HandsConnection): string {
  if (path.startsWith("/")) {
    return path;
  }
  const home = String(connection.info.home ?? "");
  if (path === "~") {
    return home;
  }
  return `${home}/${path.replace(/^~\//, "")}`;
}

/** Starts `command` with `bash -c` as job `key`; a job already started with that key is left as it is (a replay). */
function startJob(
  connection: HandsConnection,
  key: string,
  command: string,
  cwd: string | undefined
): Promise<Reply> {
  return connection.request("job.start", {
    key,
    command,
    ...(cwd ? { cwd: absolute(cwd, connection) } : {}),
  });
}

/** Reads a job's output until it ends or `timeout` seconds pass. */
async function follow(
  connection: HandsConnection,
  machine: Machine,
  key: string,
  timeout: number,
  context: Context
): Promise<ToolExecutionResult> {
  const signal = context.abortSignal;
  const deadline = Date.now() + timeout * 1000;
  let offset = 0;
  let tail = Buffer.alloc(0);
  while (true) {
    const chunk = await connection.request(
      "job.output",
      { key, offset, maxBytes: 256 * 1024 },
      { signal }
    );
    tail = Buffer.concat([tail, chunk.payload]);
    if (tail.length > MAX_OUTPUT * 2) {
      tail = tail.subarray(tail.length - MAX_OUTPUT);
    }
    offset = Number(chunk.json.nextOffset ?? offset + chunk.payload.length);
    if (chunk.json.eof === true) {
      break;
    }
    if (Date.now() >= deadline) {
      return text(
        `Still running on ${machine.name} as job ${key}. Output so far:\n${outputText(tail)}\nIt keeps running: hands_job_wait to keep waiting, hands_job_cancel to stop it.`
      );
    }
    await connection.request(
      "job.wait",
      {
        key,
        timeoutMs: Math.max(250, Math.min(3000, deadline - Date.now())),
      },
      { signal }
    );
  }
  const { json } = await connection.request("job.status", { key });
  const state = String(json.state ?? "exited");
  const code = typeof json.exitCode === "number" ? json.exitCode : null;
  const summary = `${state}${code === null ? "" : `, exit code ${code}`} on ${machine.name}`;
  return {
    output: [{ type: "text", text: `${outputText(tail)}\n[${summary}]` }],
    isError: code === null ? state !== "exited" : code !== 0,
  };
}

/**
 * Copies a file of a machine to `destination`, part by part, so a large file never sits in memory; it fails for a file
 * over `limit` bytes.
 */
export async function machineFile(
  hands: Hands,
  workspaceId: string,
  machineName: string,
  path: string,
  destination: string,
  limit: number
): Promise<void> {
  const machine = machineNamed(hands, workspaceId, machineName);
  const tooLarge = () =>
    new Error(`${path} on ${machine.name} is over ${size(limit)}`);
  // A new connection after a lost one copies the file again from the start.
  await hands.with(workspaceId, machine, async (connection) => {
    const { json } = await connection.request("open", {
      path: absolute(path, connection),
    });
    const { handle } = json;
    if (typeof handle !== "number") {
      throw new Error(
        String(
          (json.statError as { message?: string })?.message ??
            `cannot open ${path}`
        )
      );
    }
    const writer = Bun.file(destination).writer();
    try {
      if (Number((json.stat as { size?: number })?.size) > limit) {
        throw tooLarge();
      }
      let offset = 0;
      while (true) {
        const { payload } = await connection.request("pread", {
          handle,
          offset,
          length: FILE_PART,
        });
        offset += payload.length;
        // The file can grow after it was opened.
        if (offset > limit) {
          throw tooLarge();
        }
        writer.write(payload);
        await writer.flush();
        if (payload.length < FILE_PART) {
          return;
        }
      }
    } finally {
      await writer.end();
      await connection.request("close", { handle }).catch(() => {
        // The connection closed, and the handle with it.
      });
    }
  });
}

/**
 * Writes a file of Golem's to `path` on a machine, part by part, creating missing folders; returns the absolute path.
 */
export function fileToMachine(
  hands: Hands,
  workspaceId: string,
  machineName: string,
  source: string,
  path: string
): Promise<string> {
  const machine = machineNamed(hands, workspaceId, machineName);
  // A new connection after a lost one writes the file again from the start.
  return hands.with(workspaceId, machine, async (connection) => {
    const target = absolute(path, connection);
    const file = Bun.file(source);
    let offset = 0;
    do {
      const payload = await file.slice(offset, offset + FILE_PART).bytes();
      await connection.request(
        "write",
        { path: target, append: offset > 0 },
        { payload }
      );
      offset += payload.length;
    } while (offset < file.size);
    return target;
  });
}

function size(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${bytes / 1024 ** 3} GB`
    : `${bytes / 1024 ** 2} MB`;
}

/** A text file's first `MAX_TEXT` bytes; `text` is null when they are not UTF-8, `truncated` when the file is longer. */
async function readText(connection: HandsConnection, path: string) {
  const { json } = await connection.request("open", { path });
  const { handle } = json;
  if (typeof handle !== "number") {
    throw new Error(
      String(
        (json.statError as { message?: string })?.message ??
          `cannot open ${path}`
      )
    );
  }
  try {
    const { payload } = await connection.request("pread", {
      handle,
      offset: 0,
      length: MAX_TEXT + 1,
    });
    const truncated = payload.length > MAX_TEXT;
    const data = payload.subarray(0, MAX_TEXT);
    let decoded: string | null = null;
    if (!truncated) {
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        // Not UTF-8: `text` stays null.
      }
    }
    return { data, text: decoded, truncated };
  } finally {
    await connection.request("close", { handle }).catch(() => {
      // The connection closed, and the handle with it.
    });
  }
}

/** `listFiles` records: a kind byte (f, d, l), the path relative to `root`, and NUL. */
function listing(reply: Reply, root: string): string {
  const lines = Buffer.from(reply.payload)
    .toString("utf8")
    .split("\0")
    .filter((record) => record.length > 1)
    .map((record) => record.slice(1) + (record[0] === "d" ? "/" : ""));
  if (lines.length === 0) {
    return `${root} is empty.`;
  }
  return lines.join("\n") + (reply.json.truncated ? "\n(truncated)" : "");
}

function outputText(data: Buffer): string {
  const output = data.toString("utf8");
  return output.length > MAX_OUTPUT ? `…${output.slice(-MAX_OUTPUT)}` : output;
}

function text(value: string): ToolExecutionResult {
  return { output: [{ type: "text", text: value }] };
}

function hosts(machine: Machine): string[] {
  return [
    ...new Set([machine.hostname, ...machine.addresses].filter(Boolean)),
  ] as string[];
}

function displayOs(os: string): string {
  return (
    ({ macos: "macOS", linux: "Linux" } as Record<string, string>)[os] ?? os
  );
}
