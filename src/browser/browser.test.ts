import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { Egress } from "../platform/egress.ts";
import { Browser, type BrowserRunner, browserRequirements } from "./browser.ts";

/** A runner that records each call and answers like agent-browser; it writes the screenshot it is asked for. */
function fakeCli(output = "✓ Example Domain") {
  const calls: { args: readonly string[]; commands: string[][] }[] = [];
  const run: BrowserRunner = async (args, input) => {
    const commands = JSON.parse(input) as string[][];
    calls.push({ args, commands });
    const screenshot = commands.find((command) => command[0] === "screenshot");
    if (screenshot) {
      await Bun.write(screenshot[1]!, new Uint8Array([137, 80, 78, 71]));
    }
    return output;
  };
  return { run, calls };
}

describe("Browser", () => {
  test("runs the commands in the thread's session under Golem's policy", async () => {
    const cli = fakeCli();
    const result = await new Browser(cli.run).browse(
      "golem-w-1",
      [
        ["open", "example.com"],
        ["snapshot", "-i"],
      ],
      false
    );
    expect(result).toEqual({ text: "✓ Example Domain", screenshot: null });
    const [call] = cli.calls;
    expect(call!.args.slice(0, 2)).toEqual(["--session", "golem-w-1"]);
    expect(call!.args).toContain("--content-boundaries");
    expect(call!.args.at(-1)).toBe("batch");
    expect(call!.args[call!.args.indexOf("--action-policy") + 1]).toEndWith(
      "browser/policy.json"
    );
    expect(call!.args[call!.args.indexOf("--proxy") + 1]).toMatch(
      /^socks5:\/\/127\.0\.0\.1:\d+$/
    );
    expect(call!.args[call!.args.indexOf("--proxy-bypass") + 1]).toBe(
      "<-loopback>"
    );
    expect(call!.commands).toEqual([
      ["open", "example.com"],
      ["snapshot", "-i"],
    ]);
  });

  test("each person of a thread has a browser session of their own", async () => {
    const cli = fakeCli();
    let requester: string | null = "alice";
    const [tool] = new Browser(cli.run).tools("w", async () => requester);
    const run = () =>
      tool!.execute(
        { commands: [["open", "example.com"]] },
        { conversationId: 7 } as never,
        {} as never
      );
    await run();
    requester = "bob";
    await run();
    requester = null;
    await run();
    expect(cli.calls.map((call) => call.args[1])).toEqual([
      "golem-w-7-alice",
      "golem-w-7-bob",
      "golem-w-7-golem",
    ]);
  });

  test("refuses read with an address and options that change the browser", async () => {
    const cli = fakeCli();
    const browser = new Browser(cli.run);
    await expect(
      browser.browse("s", [["read", "http://192.168.1.1"]], false)
    ).rejects.toThrow("read takes no address");
    await expect(browser.browse("s", [["launch"]], false)).rejects.toThrow(
      "The browser starts by itself"
    );
    for (const command of [
      ["open", "--executable-path", "/x", "https://a.example"],
      ["open", "--args", "--no-sandbox", "https://a.example"],
      ["open", "--allow-file-access", "https://a.example"],
      ["snapshot", "--cdp", "9222"],
    ]) {
      await expect(browser.browse("s", [command], false)).rejects.toThrow(
        "takes no option"
      );
    }
    await browser.browse(
      "s",
      [["read"], ["wait", "--load", "load"], ["snapshot", "-i", "-c"]],
      false
    );
    expect(cli.calls).toHaveLength(1);
  });

  test("opens only web addresses, so the files of the server stay closed", async () => {
    const cli = fakeCli();
    const browser = new Browser(cli.run);
    for (const command of [
      ["open", "file:///etc/hosts"],
      ["goto", "FILE:///etc/hosts"],
      ["navigate", "chrome://version"],
      ["open", "view-source:file:///etc/hosts"],
      ["open", " file:///etc/hosts"],
      ["tab", "new", "file:///etc/hosts"],
    ]) {
      await expect(browser.browse("s", [command], false)).rejects.toThrow(
        "only http and https"
      );
    }
    await browser.browse(
      "s",
      [
        ["open", "https://example.com"],
        ["open", "http://example.com/a?b=c:d"],
        ["tab", "new", "example.org"],
        ["fill", "@e1", "file:///looks/like/a/path"],
      ],
      false
    );
    expect(cli.calls).toHaveLength(1);
  });

  test("takes the screenshot itself and gives its picture", async () => {
    const cli = fakeCli("✓ Screenshot saved");
    const browser = new Browser(cli.run);
    await expect(
      browser.browse("s", [["screenshot", "/tmp/anywhere.png"]], false)
    ).rejects.toThrow("Set screenshot to true");
    const result = await browser.browse("s", [["open", "example.com"]], true);
    expect(result.screenshot).toEqual(new Uint8Array([137, 80, 78, 71]));
    const last = cli.calls[0]!.commands.at(-1)!;
    expect(last[0]).toBe("screenshot");
    expect(await Bun.file(last[1]!).exists()).toBe(false);
  });

  test("gives the output also when a command fails", async () => {
    const output = "✓ Example Domain\n✗ Unknown ref: e9";
    const browser = new Browser(fakeCli(output).run);
    const result = await browser.browse("s", [["click", "@e9"]], false);
    expect(result.text).toBe(output);
  });
});

describe("Browser.pdf", () => {
  test("prints a page in Chrome with its scripts, on the paper size its CSS asks for", async () => {
    const pdf = await getDocumentProxy(
      await new Browser().pdf(
        '<style>@page { size: A4 }</style><h1>Invite</h1><p id="time"></p><script>document.getElementById("time").textContent = "Saturday at 5";</script>'
      )
    );
    expect((await pdf.getPage(1)).view.map(Math.round)).toEqual([
      0, 0, 595, 842,
    ]);
    expect((await extractText(pdf, { mergePages: true })).text).toBe(
      "Invite\nSaturday at 5"
    );
  }, 30_000);
});

describe("the egress proxy", () => {
  const seen: string[] = [];
  const local = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      seen.push(pathname);
      if (pathname === "/away") {
        return Response.redirect(
          `http://127.0.0.2:${new URL(request.url).port}/file`,
          302
        );
      }
      return new Response("<title>Local secret</title>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  afterAll(() => local.stop(true));

  test("Chrome reaches no loopback address, by address or by name", async () => {
    seen.length = 0;
    const browser = new Browser();
    const session = `golem-test-${crypto.randomUUID()}`;
    try {
      const { text } = await browser.browse(
        session,
        [
          ["open", `http://127.0.0.1:${local.port}/direct`],
          ["open", `http://localhost:${local.port}/name`],
          [
            "eval",
            `fetch("http://127.0.0.1:${local.port}/script").then(() => "reached", () => "refused")`,
          ],
        ],
        false
      );
      expect(text).toContain("ERR_SOCKS_CONNECTION_FAILED");
      expect(text).toContain("refused");
      expect(seen).toEqual([]);
    } finally {
      await browser.browse(session, [["close"]], false);
    }
  }, 60_000);

  test("download refuses a local address and a redirect to one, and keeps the file it may reach", async () => {
    const directory = await mkdtemp(join(tmpdir(), "golem-download-"));
    const destination = join(directory, "file");
    try {
      await expect(
        new Browser().download(
          `http://127.0.0.1:${local.port}/file`,
          destination,
          undefined
        )
      ).rejects.toThrow("answered 403");
      const loopbackOnly = new Browser(
        undefined,
        new Egress((address) => address === "127.0.0.1")
      );
      await expect(
        loopbackOnly.download(
          `http://127.0.0.1:${local.port}/away`,
          destination,
          undefined
        )
      ).rejects.toThrow("answered 403");
      expect(
        await loopbackOnly.download(
          `http://127.0.0.1:${local.port}/report.html`,
          destination,
          undefined
        )
      ).toBe("report.html");
      expect(await Bun.file(destination).text()).toBe(
        "<title>Local secret</title>"
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("browserRequirements", () => {
  const doctor =
    (checks: { status: string; message: string }[]): BrowserRunner =>
    async () =>
      JSON.stringify({ checks });

  test("names the failed doctor checks", async () => {
    const [ready] = await browserRequirements(
      doctor([{ status: "pass", message: "Chrome 155" }])
    );
    expect(ready!.problem).toBeNull();
    const [broken] = await browserRequirements(
      doctor([
        { status: "fail", message: "Chrome not found" },
        { status: "info", message: "No encryption key" },
      ])
    );
    expect(broken!.problem).toBe("Chrome not found");
  });

  test("reports an agent-browser that does not run", async () => {
    const [requirement] = await browserRequirements(async () => {
      throw new Error("spawn failed");
    });
    expect(requirement!.problem).toContain("spawn failed");
  });
});
