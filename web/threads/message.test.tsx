import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import type { Message, Work } from "../app/types.ts";
import Markdown from "./markdown.tsx";
import { MessageView } from "./message.tsx";

/** The HTML of `node` on a page of the app's router. */
async function render(node: ReactNode): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory(),
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}

test("an answer's thread links open the thread, its files show, and nothing in it runs", async () => {
  const html = await render(
    <Markdown
      text={[
        "Started [Dinner <b>plan</b>](thread:abc-1), <i>*soon*</i>, and read ![the list](file:f-1).",
        '<img src="x" onerror="alert(1)"><script>alert(2)</script>',
        '[bad](javascript:alert(3)) <a href="https://example.com" onclick="alert(4)">site</a>',
        '<iframe src="https://example.com"></iframe>',
      ].join("\n\n")}
      workspaceId="family"
    />
  );
  expect(html).toContain('class="thread-link" href="/w/family/t/abc-1"');
  expect(html).toContain("Dinner <b>plan</b>");
  expect(html).toContain('src="/api/v1/workspaces/family/files/f-1"');
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain("<i><em>soon</em></i>");
  for (const unsafe of [
    "onerror",
    "onclick",
    "<script",
    "javascript:",
    "<iframe",
  ]) {
    expect(html).not.toContain(unsafe);
  }
});

test("a picture from another site shows as a link, and loads nothing", async () => {
  const html = await render(
    <Markdown
      text={[
        "![the dog](https://example.com/p.png)",
        '<img src="https://example.com/q.png">',
        '<picture><source srcset="https://example.com/r.png"></picture>',
      ].join("\n\n")}
      workspaceId="family"
    />
  );
  expect(html).toContain('href="https://example.com/p.png"');
  expect(html).toContain(">the dog</a>");
  expect(html).not.toContain('src="https');
  expect(html).not.toMatch(/srcset/i);
});

test("only a link to a path of this site opens in the app; one to another site opens a new tab", async () => {
  const html = await render(
    <Markdown
      text={[
        "[home](/w/family)",
        "[evil](//evil.example/a)",
        '<a href="/&#9;/evil.example/b">tab</a>',
        '<a href="/\\evil.example/c">slash</a>',
      ].join("\n\n")}
      workspaceId="family"
    />
  );
  expect(html).toContain('<a href="/w/family">home</a>');
  for (const link of html.match(/<a [^>]*evil\.example[^>]*>/g) ?? []) {
    expect(link).toContain('target="_blank"');
  }
  expect(html.match(/<a [^>]*evil\.example[^>]*>/g)).toHaveLength(3);
});

test("an artifact in an answer runs in its own sandboxed page", async () => {
  const html = await render(
    <Markdown text="![Votes](artifact:amber-fox)" workspaceId="family" />
  );
  expect(html).toContain('<iframe class="message-artifact"');
  expect(html).toContain('src="/a/amber-fox"');
});

const message = (work: Work): Message => ({
  id: "m",
  authorId: null,
  author: "Golem",
  agent: true,
  text: "",
  time: 0,
  failed: false,
  streaming: work.endedAt === null,
  files: [],
  work,
});

const call = (text: string) => ({
  kind: "tool" as const,
  text,
  tool: "start_thread",
  input: null,
  output: null,
  running: false,
  failed: false,
});

test("the work before an answer is open while the agent works, then folds and says how long it took", async () => {
  const working = await render(
    <MessageView
      message={message({
        startedAt: Date.now() - 12_000,
        endedAt: null,
        stopped: false,
        steps: [{ ...call("Prague"), tool: "web_search", running: true }],
      })}
      workspaceId="w"
    />
  );
  expect(working).toContain('<details class="work working" open="">');
  expect(working).toContain("Working for <!-- -->12s");
  expect(working).toContain("Web search");

  const done = await render(
    <MessageView
      message={message({
        startedAt: 1000,
        endedAt: 9000,
        stopped: false,
        steps: [],
      })}
      workspaceId="w"
    />
  );
  expect(done).toContain('<details class="work">');
  expect(done).toContain("Worked for 8s");
});

test("calls of one tool in a row fold into one row, and a stopped turn says so", async () => {
  const html = await render(
    <MessageView
      message={message({
        startedAt: 1000,
        endedAt: 4000,
        stopped: true,
        steps: [call("[Dinner](thread:d-1)"), call("[Trip](thread:t-2)")],
      })}
      workspaceId="w"
    />
  );
  expect(html).toContain("Stopped after 3s");
  expect(html).toContain(
    '<span class="work-tool-name">Start thread</span><span class="work-tool-detail">2<!-- --> times</span>'
  );
  expect(html).toContain('class="thread-link" href="/w/w/t/d-1">Dinner</a>');
});
