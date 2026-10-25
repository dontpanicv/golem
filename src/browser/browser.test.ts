import { describe, expect, test } from "bun:test";
import { extractText, getDocumentProxy } from "unpdf";
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
    expect(call!.commands).toEqual([
      ["open", "example.com"],
      ["snapshot", "-i"],
    ]);
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
