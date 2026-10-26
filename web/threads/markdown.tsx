import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { fileHref } from "../app/api.ts";
import { ThreadLink } from "./thread-link.tsx";

/** Where the addresses that agents write go: `thread:<id>`, `file:<id>`, and `artifact:<id>`. */
const SCHEME = /^(thread|file|artifact):([\w-]+)$/;

/**
 * What an agent writes can hold simple HTML. The sanitizer keeps what cannot run or restyle the page, and Golem's own
 * addresses.
 */
const SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      "thread",
      "file",
      "artifact",
    ],
    src: ["https", "data", "file", "artifact"],
  },
};

function urlTransform(url: string, key: string): string {
  if (SCHEME.test(url) || (key === "src" && url.startsWith("data:image/"))) {
    return url;
  }
  return defaultUrlTransform(url);
}

/**
 * An agent's Markdown. A link to `thread:<id>` opens the thread, to `file:<id>` the file, and to `artifact:<id>` the
 * artifact in the side panel; a picture of `file:<id>` shows the file, and of `artifact:<id>` the artifact itself.
 *
 * @example
 * <Markdown text="See ![the screen](file:0199)" workspaceId={workspaceId} />
 */
export default function Markdown({
  text,
  workspaceId,
}: {
  text: string;
  workspaceId: string;
}) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => (
          <MarkdownLink href={href} workspaceId={workspaceId}>
            {children}
          </MarkdownLink>
        ),
        img: ({ src, alt }) => (
          <MarkdownPicture
            alt={alt}
            src={typeof src === "string" ? src : undefined}
            workspaceId={workspaceId}
          />
        ),
      }}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, SCHEMA]]}
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
    >
      {text}
    </ReactMarkdown>
  );
}

function MarkdownLink({
  href,
  workspaceId,
  children,
}: {
  href: string | undefined;
  workspaceId: string;
  children: ReactNode;
}) {
  const [, scheme, id] = href?.match(SCHEME) ?? [];
  if (scheme === "thread") {
    return (
      <ThreadLink threadId={id!} workspaceId={workspaceId}>
        {children}
      </ThreadLink>
    );
  }
  if (scheme === "file") {
    return (
      <a href={fileHref(workspaceId, id!)} rel="noopener" target="_blank">
        {children}
      </a>
    );
  }
  if (scheme === "artifact") {
    return (
      <Link search={(previous) => ({ ...previous, artifact: id })} to=".">
        {children}
      </Link>
    );
  }
  if (href?.startsWith("/")) {
    return <a href={href}>{children}</a>;
  }
  return (
    <a href={href} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

function MarkdownPicture({
  src,
  alt,
  workspaceId,
}: {
  src: string | undefined;
  alt: string | undefined;
  workspaceId: string;
}) {
  const [, scheme, id] = src?.match(SCHEME) ?? [];
  if (scheme === "artifact") {
    // The artifact's own page runs it in a sandboxed frame, as the side panel shows it.
    return (
      <iframe
        className="message-artifact"
        loading="lazy"
        src={`/a/${id}`}
        title={alt || "Artifact"}
      />
    );
  }
  const url = scheme === "file" ? fileHref(workspaceId, id!) : src;
  return url ? (
    // biome-ignore lint/correctness/useImageSize: an agent's picture has no known size
    <img alt={alt} loading="lazy" src={url} />
  ) : null;
}
