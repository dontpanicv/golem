import { expect, test } from "bun:test";
import { markdown } from "./markdown.ts";

const links = {
  thread: (id: string) => `/w/w1/t/${id}`,
  file: (id: string) => `/w/w1/files/${id}`,
  afterThread: (id: string) =>
    `<span class="working-spinner" data-show="$working.t${id}"></span>`,
};

test("Golem's addresses open threads, files, and artifacts", () => {
  expect(
    markdown(
      "**Done:** [Trip](thread:t1), ![screen](file:f1), [poll](artifact:a1)\n\n![Poll](artifact:a1)",
      links
    )
  ).toBe(
    '<p><strong>Done:</strong> <a href="/w/w1/t/t1" class="thread-link">Trip</a><span class="working-spinner" data-show="$working.tt1"></span>, <img alt="screen" src="/w/w1/files/f1" loading="lazy" />, <a href="?artifact=a1">poll</a></p>\n<p><iframe class="message-artifact" src="/a/a1" title="Poll" loading="lazy"></iframe></p>\n'
  );
});

test("simple HTML stays, and nothing in it runs or reaches the page around it", () => {
  const html = markdown(
    [
      "<details open><summary>More</summary><kbd>⌘K</kbd></details>",
      "<script>alert(1)</script><xmp><img src=x onerror=alert(1)></xmp>",
      `<div id="transcript" class="toast" style="position: fixed" data-on:click="@post('/x')">hi</div></article></section>`,
      '<a href="javascript:alert(1)">a</a> <a href="//evil.example">b</a> <img src="http://e.example/a.png">',
      "<div><b>left open",
    ].join("\n\n"),
    links
  );
  expect(html).toBe(
    '<details open=""><summary>More</summary><kbd>⌘K</kbd></details>\n\n<div>hi</div>\n<p><a>a</a> <a>b</a> </p>\n<div><b>left open\n</b></div>'
  );
});

test("web links open in a new tab, and quotes cannot end an attribute", () => {
  expect(
    markdown(
      `https://example.com/a and <img src="https://example.com/b.png?x=<i>" title='"><i>'>`,
      links
    )
  ).toBe(
    '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a> and <img title="&quot;i" src="https://example.com/b.png?x=%3Ci%3E" loading="lazy"></p>\n'
  );
});
