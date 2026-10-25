// An agent's answer as HTML: Markdown with simple HTML in it. Scripts, styles, event handlers, ids, classes, and
// Datastar attributes never get through: what an agent writes cannot run, restyle the page, or take part in patches.

const escapeHtml = Bun.escapeHTML;

/** Where the addresses that agents write go: `thread:<id>`, `file:<id>`, and `artifact:<id>`. */
export interface Links {
  readonly thread: (threadId: string) => string;
  readonly file: (fileId: string) => string;
  /** HTML after a thread link, such as the spinner that shows while its agent works. */
  readonly afterThread: (threadId: string) => string;
}

const ALLOWED = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
]);

/** Elements left out with their content: what runs, loads, takes input, or holds raw text. */
const DROPPED = new Set([
  "audio",
  "base",
  "button",
  "embed",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "link",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "plaintext",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "video",
  "xmp",
]);

const ATTRIBUTES = new Set([
  "align",
  "alt",
  "checked",
  "colspan",
  "datetime",
  "height",
  "open",
  "rowspan",
  "start",
  "title",
  "width",
]);

const VOID = new Set(["br", "hr", "img", "input"]);

const SCHEME = /^(thread|file|artifact):([\w-]+)$/;

/**
 * Renders an agent's Markdown. A link to `thread:<id>` opens the thread, to `file:<id>` the file, and to
 * `artifact:<id>` the artifact in the side panel; a picture of `file:<id>` shows the file, and a picture of
 * `artifact:<id>` shows the artifact itself in the message.
 *
 * @example
 * markdown("See ![the screen](file:0199)", links); // <p>See <img src="/w/…/files/0199" alt="the screen"></p>
 */
export function markdown(text: string, links: Links): string {
  return balanced(
    sanitize(Bun.markdown.html(text, { autolinks: true }), links)
  );
}

function sanitize(html: string, links: Links): string {
  return new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName;
        if (DROPPED.has(tag)) {
          element.remove();
          return;
        }
        if (!ALLOWED.has(tag)) {
          element.removeAndKeepContent();
          return;
        }
        const href = element.getAttribute("href");
        const src = element.getAttribute("src");
        const type = element.getAttribute("type");
        for (const [name, value] of [...element.attributes]) {
          element.removeAttribute(name);
          if (ATTRIBUTES.has(name)) {
            element.setAttribute(name, value.replaceAll(/[<>]/g, ""));
          }
        }
        if (tag === "a") {
          link(element, href, links);
        } else if (tag === "img") {
          picture(element, src, links);
        } else if (tag === "input") {
          // Only the boxes of a task list.
          if (type === "checkbox") {
            element.setAttribute("type", "checkbox");
            element.setAttribute("disabled", "");
          } else {
            element.remove();
          }
        }
      },
    })
    .onDocument({
      comments: (comment) => {
        comment.remove();
      },
      doctype: (doctype) => {
        doctype.remove();
      },
    })
    .transform(html);
}

function link(
  element: HTMLRewriterTypes.Element,
  href: string | null,
  links: Links
) {
  const own = href?.match(SCHEME);
  if (own) {
    const [, scheme, id] = own as unknown as [string, string, string];
    if (scheme === "thread") {
      element.setAttribute("href", links.thread(id));
      element.setAttribute("class", "thread-link");
      element.after(links.afterThread(id), { html: true });
    } else if (scheme === "file") {
      element.setAttribute("href", links.file(id));
      element.setAttribute("target", "_blank");
    } else {
      element.setAttribute("href", `?artifact=${id}`);
    }
    return;
  }
  const url = address(href, ["http:", "https:", "mailto:", "tel:"]);
  if (url) {
    element.setAttribute("href", url);
    if (!url.startsWith("/")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
  }
}

function picture(
  element: HTMLRewriterTypes.Element,
  src: string | null,
  links: Links
) {
  const own = src?.match(SCHEME);
  if (own?.[1] === "artifact") {
    const title = element.getAttribute("alt") || "Artifact";
    // The artifact's own page runs it in a sandboxed frame, as the side panel shows it.
    element.replace(
      `<iframe class="message-artifact" src="/a/${own[2]}" title="${escapeHtml(title)}" loading="lazy"></iframe>`,
      { html: true }
    );
    return;
  }
  const url =
    own?.[1] === "file"
      ? links.file(own[2]!)
      : (address(src, ["https:"]) ??
        (src?.startsWith("data:image/") ? src : null));
  if (url) {
    element.setAttribute("src", url.replaceAll('"', "%22"));
    element.setAttribute("loading", "lazy");
  } else {
    element.remove();
  }
}

/** An address of one of `schemes`, or a path on this site, in a form with no quotes or angle brackets. */
function address(
  value: string | null,
  schemes: readonly string[]
): string | null {
  if (!value) {
    return null;
  }
  if (value.startsWith("/") && !value.startsWith("//")) {
    const url = new URL(value, "https://golem.invalid");
    return `${url.pathname}${url.search}${url.hash}`;
  }
  const url = URL.parse(value);
  return url && schemes.includes(url.protocol) ? url.href : null;
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;

/**
 * Closes what is left open and leaves out end tags that close nothing, so no tag closes the elements around the
 * message. Sanitized attributes hold no angle brackets, so each tag ends at its first `>`.
 */
function balanced(html: string): string {
  const open: string[] = [];
  const result = html.replace(TAG, (tag, end: string, name: string) => {
    const lower = name.toLowerCase();
    if (!end) {
      if (!VOID.has(lower)) {
        open.push(lower);
      }
      return tag;
    }
    const index = open.lastIndexOf(lower);
    if (index === -1) {
      return "";
    }
    return open
      .splice(index)
      .toReversed()
      .map((closed) => `</${closed}>`)
      .join("");
  });
  return (
    result +
    open
      .toReversed()
      .map((closed) => `</${closed}>`)
      .join("")
  );
}
