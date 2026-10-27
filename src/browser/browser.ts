import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Egress } from "../platform/egress.ts";
import type { Requirement } from "../platform/requirements.ts";
import { browserSession, browserTools } from "./tools.ts";

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
/** The options that agents may give; others, such as `--executable-path`, change the browser itself. */
const OPTIONS = new Set([
  "-i",
  "--interactive",
  "-c",
  "--compact",
  "-d",
  "--depth",
  "-s",
  "--selector",
  "--load",
]);
/** The largest file that download keeps. */
const MAX_DOWNLOAD = 100 * 1024 ** 2;
/** How long download waits for a file, all of it. */
const DOWNLOAD_TIMEOUT = 10 * 60_000;

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
 * A headless Chrome for each thread and person, driven by Vercel's agent-browser, so that agents can visit websites.
 * Each session keeps its tabs and logins until it closes or stays idle for an hour. All web traffic of agents goes
 * through `egress`, which reaches public addresses only.
 */
export class Browser {
  constructor(
    private readonly run: BrowserRunner = runCli,
    private readonly egress = new Egress()
  ) {}

  /** The agent tools of a workspace; `requesterOf` gives the person of a conversation's turn. */
  tools(
    workspaceId: string,
    requesterOf: (conversationId: ConversationId) => Promise<string | null>
  ) {
    return browserTools(this, workspaceId, requesterOf);
  }

  /** A picture of the page in the browser of a thread and person, or null when it cannot take one. */
  async screenshot(
    workspaceId: string,
    conversationId: number,
    personId: string | null
  ): Promise<Uint8Array | null> {
    const { screenshot } = await this.browse(
      browserSession(workspaceId, conversationId, personId),
      [],
      true
    );
    return screenshot;
  }

  /**
   * Downloads a file from the web to `destination` and returns its name. The request and each redirect go through the
   * egress proxy. It fails over 100 MB, before more of the file is read.
   */
  async download(
    address: string,
    destination: string,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const url = URL.parse(address);
    if (url?.protocol !== "http:" && url?.protocol !== "https:") {
      throw new Error(
        `save_file gets only http and https addresses, not ${address}.`
      );
    }
    const response = await fetch(url, {
      proxy: `http://127.0.0.1:${await this.egress.port()}`,
      keepalive: false,
      signal: AbortSignal.any([
        AbortSignal.timeout(DOWNLOAD_TIMEOUT),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `${url} answered ${response.status} ${response.statusText}`
      );
    }
    const tooLarge = new Error(`${url} is over ${MAX_DOWNLOAD / 1024 ** 2} MB`);
    if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD) {
      await response.body?.cancel();
      throw tooLarge;
    }
    const writer = Bun.file(destination).writer();
    let size = 0;
    try {
      // Leaving the loop cancels the rest of the body.
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > MAX_DOWNLOAD) {
          throw tooLarge;
        }
        writer.write(chunk);
      }
    } finally {
      await writer.end();
    }
    return (
      dispositionName(response.headers.get("content-disposition")) ||
      decodeName(url.pathname.split("/").at(-1)!) ||
      "download"
    );
  }

  /**
   * A PDF of a page, printed in a Chrome of its own with the page size its CSS asks for and its backgrounds. Golem
   * prints through Chrome's DevTools protocol, because agent-browser's `pdf` keeps neither.
   */
  async pdf(html: string): Promise<Uint8Array> {
    const session = `golem-print-${randomUUID()}`;
    try {
      const output = await this.run(
        ["--session", session, ...(await this.proxy()), "batch"],
        JSON.stringify([["open"], ["get", "cdp-url"]])
      );
      const chrome = /ws:\/\/([^\s/]+)/.exec(output)?.[1];
      if (!chrome) {
        throw new Error(`Chrome did not start: ${output}`);
      }
      const page = (await (
        await fetch(`http://${chrome}/json/new?about:blank`, { method: "PUT" })
      ).json()) as { webSocketDebuggerUrl: string };
      return await printPage(page.webSocketDebuggerUrl, html);
    } finally {
      await this.run(["--session", session, "close"], "").catch(() => {
        // Chrome stopped already.
      });
    }
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
          ...(await this.proxy()),
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

  /**
   * Chrome's options for the egress proxy. Chrome sends host names to a SOCKS5 proxy, which resolves them;
   * `<-loopback>` sends loopback addresses through it too, and WebRTC sends no UDP past it. A session that runs with
   * other options, such as an older port, starts its Chrome again.
   */
  private async proxy(): Promise<string[]> {
    return [
      "--proxy",
      `socks5://127.0.0.1:${await this.egress.port()}`,
      "--proxy-bypass",
      "<-loopback>",
      "--args",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ];
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

/**
 * Writes the HTML into a blank page, waits for its pictures and fonts, and prints it. The page has no origin, and the
 * content policy in the HTML of an artifact still holds.
 */
async function printPage(address: string, html: string): Promise<Uint8Array> {
  const socket = new WebSocket(address);
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  let next = 0;
  const closed = new Promise<never>((_resolve, reject) => {
    socket.addEventListener("close", () =>
      reject(new Error("Chrome closed the page"))
    );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    const call = message.id === undefined ? null : pending.get(message.id);
    if (call) {
      pending.delete(message.id!);
      if (message.error) {
        call.reject(new Error(message.error.message));
      } else {
        call.resolve(message.result);
      }
    }
  });
  const send = <T>(method: string, params: object) => {
    next += 1;
    const id = next;
    socket.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      new Promise<T>((resolve, reject) =>
        pending.set(id, {
          resolve: resolve as (result: unknown) => void,
          reject,
        })
      ),
      closed,
    ]);
  };
  const timer = setTimeout(() => socket.close(), TIMEOUT);
  try {
    await Promise.race([
      new Promise((resolve) => socket.addEventListener("open", resolve)),
      closed,
    ]);
    await send("Runtime.evaluate", {
      expression: `document.open(); document.write(${JSON.stringify(html)}); document.close();`,
    });
    await send("Runtime.evaluate", {
      expression:
        'new Promise((loaded) => document.readyState === "complete" ? loaded() : addEventListener("load", loaded)).then(() => document.fonts.ready).then(() => undefined)',
      awaitPromise: true,
    });
    const { data } = await send<{ data: string }>("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Uint8Array.fromBase64(data);
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

/**
 * Refuses what the policy cannot see: an address that is not on the web, `read <url>`, which agent-browser fetches
 * itself and not through Chrome, options that change the browser, and a screenshot to a path of its own.
 */
function checkCommand(command: readonly string[]): void {
  const [name = "", ...args] = command;
  if (name === "screenshot") {
    throw new Error("Set screenshot to true to see the page.");
  }
  // The policy allows `launch` for Golem's own options, which start Chrome behind the egress proxy.
  if (name === "launch") {
    throw new Error("The browser starts by itself; open a page.");
  }
  if (name === "read" && args.length > 0) {
    throw new Error(
      "Open the page first, then read it: read takes no address."
    );
  }
  for (const option of args.filter((arg) => arg.startsWith("-"))) {
    if (!OPTIONS.has(option)) {
      throw new Error(
        `${name} takes no option ${option}, and a value cannot start with "-".`
      );
    }
  }
  let addresses: string[] = [];
  if (NAVIGATION.has(name)) {
    addresses = args;
  } else if (name === "tab" && args[0] === "new") {
    addresses = args.slice(1);
  }
  for (const address of addresses) {
    if (!(OPTIONS.has(address) || isWebAddress(address))) {
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

/** The file name of a Content-Disposition header, in its `filename*` or `filename` form. */
function dispositionName(header: string | null): string {
  const encoded = /filename\*\s*=\s*[\w-]*'[^']*'([^;]+)/i.exec(
    header ?? ""
  )?.[1];
  if (encoded) {
    return decodeName(encoded.trim());
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header ?? "")?.[1]?.trim() ?? "";
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
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
