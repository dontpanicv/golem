import {
  Fragment,
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useEffect,
  useState,
} from "react";
import { fileHref } from "../app/api.ts";
import type { Message, Step, Work } from "../app/types.ts";
import { Avatar, Mark } from "../ui/components.tsx";
import { previewLink } from "../ui/file-preview.tsx";
import { clockTime, duration } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { ThreadLink } from "./thread-link.tsx";

// Markdown and its sanitizer load on their own, once a page shows an agent's answer.
const Markdown = lazy(() => import("./markdown.tsx"));

/** An agent's Markdown; its plain text shows until the renderer loads. */
export function AgentText({
  text,
  workspaceId,
}: {
  text: string;
  workspaceId: string;
}) {
  return (
    <Suspense fallback={<p>{text}</p>}>
      <Markdown text={text} workspaceId={workspaceId} />
    </Suspense>
  );
}

/** A message; an agent's answer is Markdown, a person's message and an error show as they were written. */
export const MessageView = memo(MessageCard);

/** `pending`: a message in the outbox, which Golem does not have yet; it says so in place of its time. */
function MessageCard({
  message,
  workspaceId,
  pending = false,
}: {
  message: Message;
  workspaceId: string;
  pending?: boolean;
}) {
  const classes = [
    "message",
    message.failed && "failed",
    message.streaming && "streaming",
    pending && "pending",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={classes}>
      {message.agent ? <Mark /> : <Avatar name={message.author} />}
      <div className="message-body">
        <div className="message-meta">
          <span className="message-author">{message.author}</span>
          <time className="message-time">
            {pending ? "Sending" : clockTime(message.time)}
          </time>
        </div>
        {message.work ? (
          <WorkLog work={message.work} workspaceId={workspaceId} />
        ) : null}
        {message.text && message.agent && !message.failed ? (
          <div className="message-text prose">
            <AgentText text={message.text} workspaceId={workspaceId} />
          </div>
        ) : null}
        {message.text && !(message.agent && !message.failed) ? (
          <p className="message-text">
            <Linked text={message.text} workspaceId={workspaceId} />
          </p>
        ) : null}
        {message.files.length > 0 ? (
          <div className="file-chips">
            {message.files.map((file, index, files) => (
              <a
                className="file-chip"
                key={file.id}
                {...previewLink(
                  files.map((each) => ({
                    href: fileHref(workspaceId, each.id),
                    name: each.name,
                  })),
                  index
                )}
              >
                <Icon name="attach" />
                <span>{file.name}</span>
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** A link to a thread as agents write it in messages: `[title](thread:<id>)`. */
const THREAD_LINK = /\[([^\]\n]+)\]\(thread:([\w-]+)\)/g;

/** Text with each thread link as a link that opens the thread, and its spinner while the thread's agent works. */
function Linked({ text, workspaceId }: { text: string; workspaceId: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(THREAD_LINK)) {
    const [whole, title, threadId] = match as unknown as [
      string,
      string,
      string,
    ];
    parts.push(text.slice(last, match.index));
    parts.push(
      <Fragment key={match.index}>
        <ThreadLink threadId={threadId} workspaceId={workspaceId}>
          {title}
        </ThreadLink>
      </Fragment>
    );
    last = match.index + whole.length;
  }
  parts.push(text.slice(last));
  return parts;
}

/**
 * The work before an answer: open while the agent works, then folded into "Worked for …". Calls of one tool in a row
 * fold into one row, and each tool call opens to show its arguments and result.
 */
function WorkLog({ work, workspaceId }: { work: Work; workspaceId: string }) {
  const working = work.endedAt === null;
  const groups = runs(work.steps);
  let label: ReactNode = `Worked for ${duration(work.endedAt! - work.startedAt)}`;
  if (working) {
    label = (
      <>
        Working for <Elapsed since={work.startedAt} />
      </>
    );
  } else if (work.stopped) {
    label = `Stopped after ${duration(work.endedAt! - work.startedAt)}`;
  }
  return (
    // A new element when the work ends, so it folds then; until then, the person's choice to open or fold it stays.
    <details
      className={working ? "work working" : "work"}
      key={working ? "working" : "done"}
      open={working}
    >
      <summary className="work-summary">
        <span>{label}</span>
        {groups.length > 0 ? (
          <span className="disclosure">
            <Icon name="disclosure" />
          </span>
        ) : null}
      </summary>
      {groups.length > 0 ? (
        <ol className="work-steps" ref={working ? followEnd : undefined}>
          {groups.map(({ start, steps }) =>
            steps.length === 1 ? (
              <WorkStep
                key={start}
                step={steps[0]!}
                workspaceId={workspaceId}
              />
            ) : (
              <li key={start}>
                <details
                  className="work-group"
                  open={steps.some((step) => step.running)}
                >
                  <summary className="work-row">
                    <ToolName tool={steps[0]!.tool!} />
                    <span className="work-tool-detail">
                      {steps.length} times
                    </span>
                  </summary>
                  <ol className="work-group-steps">
                    {steps.map((step, index) => (
                      <WorkStep
                        // biome-ignore lint/suspicious/noArrayIndexKey: steps only grow, so their place is their identity
                        key={index}
                        step={step}
                        workspaceId={workspaceId}
                      />
                    ))}
                  </ol>
                </details>
              </li>
            )
          )}
        </ol>
      ) : null}
    </details>
  );
}

/** The steps in runs: each call of a tool that the call before it also made joins that call's run. */
export function runs(
  steps: readonly Step[]
): { start: number; steps: Step[] }[] {
  const result: { start: number; steps: Step[] }[] = [];
  for (const [index, step] of steps.entries()) {
    const last = result.at(-1);
    if (step.kind === "tool" && last && last.steps[0]!.tool === step.tool) {
      last.steps.push(step);
    } else {
      result.push({ start: index, steps: [step] });
    }
  }
  return result;
}

function WorkStep({ step, workspaceId }: { step: Step; workspaceId: string }) {
  if (step.kind !== "tool") {
    return (
      <li className={`work-${step.kind}`}>
        <Linked text={step.text} workspaceId={workspaceId} />
      </li>
    );
  }
  const classes = [
    "work-tool",
    step.running && "running",
    step.failed && "failed",
  ]
    .filter(Boolean)
    .join(" ");
  const io = [step.input, step.output].filter(
    (part): part is string => part !== null && part !== "" && part !== "{}"
  );
  return (
    <li>
      <details className={classes}>
        <summary className="work-row">
          <ToolName tool={step.tool!} />
          {step.text ? (
            <span className="work-tool-detail">
              <Linked text={step.text} workspaceId={workspaceId} />
            </span>
          ) : null}
        </summary>
        {io.map((part) => (
          <pre key={part}>{part}</pre>
        ))}
      </details>
    </li>
  );
}

/** A tool's name as words: `web_search` is Web search. */
function ToolName({ tool }: { tool: string }) {
  const words = tool.replaceAll("_", " ");
  return (
    <span className="work-tool-name">
      {words.charAt(0).toUpperCase() + words.slice(1)}
    </span>
  );
}

/** The time since `since`, counting up each second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return duration(now - since);
}

/**
 * Keeps the newest content of a scrolling element in view, until the person scrolls up; scrolling back to the end
 * follows again.
 *
 * @example
 * <section className="transcript" ref={followEnd}>…</section>
 */
export function followEnd(
  element: HTMLElement | null
): (() => void) | undefined {
  if (!element) {
    return;
  }
  let pinned = true;
  const follow = () => {
    if (pinned) {
      element.scrollTop = element.scrollHeight;
    }
  };
  const onScroll = () => {
    pinned =
      element.scrollHeight - element.scrollTop - element.clientHeight < 4;
  };
  const observer = new MutationObserver(follow);
  observer.observe(element, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  element.addEventListener("scroll", onScroll);
  // Pictures and artifacts get their height when they load.
  element.addEventListener("load", follow, true);
  follow();
  return () => {
    observer.disconnect();
    element.removeEventListener("scroll", onScroll);
    element.removeEventListener("load", follow, true);
  };
}
