import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Requirement } from "../platform/requirements.ts";
import { browserTools } from "./tools.ts";

/** agent-browser's launcher, which starts the native binary of this machine; it runs on Bun, as Golem does. */
const CLI = [
  process.execPath,
  Bun.resolveSync("agent-browser/bin/agent-browser.js", import.meta.dir),
];
/** The commands agents may run: pages only, no files of this machine, cookies, or browser settings. */
const POLICY = join(import.meta.dir, "policy.json");
/** The most page text one call gives the agent. */
const MAX_OUTPUT = 20_000;
/** A call that takes longer is stopped; each command also has agent-browser's own timeout. */
const TIMEOUT = 120_000;
/** The commands that take an address to open; `file:` would show the files of this machine. */
const NAVIGATION = new Set(["open", "goto", "navigate"]);

/** Runs the agent-browser CLI with these arguments and this input, and gives its output; tests replace it. */
export type BrowserRunner = (
  args: readonly string[],
  input: string
) => Promise<string>;

/** What a call of commands gives: agent-browser's text, and a PNG of the page when asked. */
export interface BrowseResult {
  readonly text: string;
  readonly screenshot: Uint8Array | null;
}

/**
 * A headless Chrome for each thread, driven by Vercel's agent-browser, so that agents can visit websites. Each session
 * keeps its tabs and logins until it closes or stays idle for an hour.
 */
export class Browser {
  constructor(private readonly run: BrowserRunner = runCli) {}

  /** The agent tools of a workspace. */
  tools(workspaceId: string) {
    return browserTools(this, workspaceId);
  }

  /** Runs commands in order in one session's browser; page text in the output is between content boundaries. */
  async browse(
    session: string,
    commands: readonly (readonly string[])[],
    screenshot: boolean
  ): Promise<BrowseResult> {
    for (const command of commands) {
      checkCommand(command);
    }
    const directory = screenshot
      ? await mkdtemp(join(tmpdir(), "golem-browser-"))
      : null;
    const picture = directory ? join(directory, "page.png") : null;
    try {
      const output = await this.run(
        [
          "--session",
          session,
          "--action-policy",
          POLICY,
          "--content-boundaries",
          "--max-output",
          String(MAX_OUTPUT),
          "batch",
        ],
        JSON.stringify(
          picture ? [...commands, ["screenshot", picture]] : commands
        )
      );
      const file = picture ? Bun.file(picture) : null;
      return {
        // A batch exits with 1 when one of its commands fails; each command says how it went.
        text: output || "Done.",
        screenshot: file && (await file.exists()) ? await file.bytes() : null,
      };
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

/** agent-browser with Chrome, checked with its own doctor, which also starts a headless Chrome once. */
export async function browserRequirements(
  run: BrowserRunner = runCli
): Promise<Requirement[]> {
  const output = await run(["doctor", "--offline", "--json"], "").catch(
    (error: unknown) => String(error)
  );
  let problem: string | null;
  try {
    const report = JSON.parse(output) as {
      checks: { status: string; message: string }[];
    };
    const failed = report.checks.filter((check) => check.status === "fail");
    problem = failed.length
      ? failed.map((check) => check.message).join("; ")
      : null;
  } catch {
    problem = output || "agent-browser does not run";
  }
  return [
    {
      name: "agent-browser and Chrome",
      purpose: "agents visiting websites",
      install:
        "bun install, then bunx --bun agent-browser install (Linux: add --with-deps)",
      problem,
    },
  ];
}

/** Refuses what the policy cannot see: an address that is not on the web, and a screenshot to a path of its own. */
function checkCommand(command: readonly string[]): void {
  const [name = "", ...args] = command;
  if (name === "screenshot") {
    throw new Error("Set screenshot to true to see the page.");
  }
  let addresses: string[] = [];
  if (NAVIGATION.has(name)) {
    addresses = args;
  } else if (name === "tab" && args[0] === "new") {
    addresses = args.slice(1);
  }
  for (const address of addresses) {
    if (!(address.startsWith("-") || isWebAddress(address))) {
      throw new Error(
        `${name} opens only http and https addresses, not ${address}.`
      );
    }
  }
}

/** An http or https address; agent-browser adds `https://` to an address without a scheme. */
function isWebAddress(address: string): boolean {
  const url = URL.parse(
    /^[a-z][a-z\d+.-]*:/i.test(address) ? address : `https://${address}`
  );
  return url?.protocol === "http:" || url?.protocol === "https:";
}

/** Runs agent-browser with its errors in the same stream, so each one stays next to the command it belongs to. */
async function runCli(args: readonly string[], input: string) {
  const child = Bun.spawn(
    ["/bin/sh", "-c", 'exec "$0" "$@" 2>&1', ...CLI, ...args],
    { stdin: new Blob([input]), stdout: "pipe", timeout: TIMEOUT }
  );
  const [output] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return output.trim();
}
