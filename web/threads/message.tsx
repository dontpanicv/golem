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
import { Avatar, Mark, type Mood, PixelSpinner } from "../ui/components.tsx";
import { fileKind } from "../ui/file-kind.ts";
import { previewLink } from "../ui/file-preview.tsx";
import { clockTime, duration } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { usePicture } from "../workspaces/data.ts";
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

/**
 * `pending`: a message in the outbox, which Golem does not have yet; it says so in place of its time. `waiting`: the
 * agent waits for a person to allow an action of this answer's work. `continued`: the message continues the one before
 * it (`continues`), so it shows no avatar, author, or time.
 */
function MessageCard({
  message,
  workspaceId,
  pending = false,
  waiting = false,
  continued = false,
}: {
  message: Message;
  workspaceId: string;
  pending?: boolean;
  waiting?: boolean;
  continued?: boolean;
}) {
  const classes = [
    "message",
    message.failed && "failed",
    message.streaming && "streaming",
    pending && "pending",
    continued && "continued",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={classes}>
      {continued ? <span className="avatar-space" /> : null}
      {!continued && message.agent ? (
        <Mark mood={moodOf(message, waiting)} />
      ) : null}
      {continued || message.agent ? null : (
        <AuthorAvatar message={message} workspaceId={workspaceId} />
      )}
      <div className="message-body">
        {continued ? null : (
          <div className="message-meta">
            <span className="message-author">{message.author}</span>
            <time className="message-time">
              {pending ? "Sending" : clockTime(message.time)}
            </time>
          </div>
        )}
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
              <FileItem
                key={file.id}
                link={previewLink(
                  files.map((each) => ({
                    href: fileHref(workspaceId, each.id),
                    name: each.name,
                  })),
                  index
                )}
                name={file.name}
                picture={`${fileHref(workspaceId, file.id)}/picture`}
              />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function AuthorAvatar({
  message,
  workspaceId,
}: {
  message: Message;
  workspaceId: string;
}) {
  return (
    <Avatar
      name={message.author}
      picture={usePicture(workspaceId, message.authorId)}
    />
  );
}

/**
 * Whether an agent's message continues the agent's message before it: a turn that the answer of another thread started,
 * such as the result of work that the message before asked that thread for.
 */
export function continues(message: Message, previous: Message | undefined) {
  return (
    message.agent && previous?.agent === true && relayedFrom(message) !== null
  );
}

/** The title of the thread whose message started this turn, or null for a turn that a person started. */
export function relayedFrom(message: Message): string | null {
  const first = message.work?.steps[0];
  return first?.tool === RELAY ? first.text.replace(THREAD_LINK, "$1") : null;
}

/** The step of a turn that another thread's message started. */
const RELAY = "from_thread";

/**
 * The face of an agent's message: it failed, it works or waits for a person, or it finished its work; an answer with
 * no work, or one that a person stopped, has the icon's own face.
 */
export function moodOf(message: Message, waiting: boolean): Mood | undefined {
  if (message.failed) {
    return "failed";
  }
  if (message.streaming || message.work?.endedAt === null) {
    return waiting ? "waiting" : "working";
  }
  return message.work && !message.work.stopped ? "done" : undefined;
}

/** A file of a message: a picture shows itself, and any other file, or a picture the server cannot convert, a chip. */
function FileItem({
  name,
  link,
  picture,
}: {
  name: string;
  link: ReturnType<typeof previewLink>;
  picture: string;
}) {
  const [failed, setFailed] = useState(false);
  if (fileKind(name) === "image" && !failed) {
    return (
      <a className="file-picture" {...link}>
        {/* biome-ignore lint/correctness/useImageSize: a file's picture has no known size */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: a load error is no person's action */}
        <img
          alt={name}
          loading="lazy"
          onError={() => setFailed(true)}
          src={picture}
        />
      </a>
    );
  }
  return (
    <a className="file-chip" {...link}>
      <Icon name="attach" />
      <span>{name}</span>
    </a>
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
        <PixelSpinner />
        <span className="shimmer">
          Working for <Elapsed since={work.startedAt} />
        </span>
        <span className="work-now">{stepTitle(work.steps.at(-1))}</span>
      </>
    );
  } else if (work.stopped) {
    label = `Stopped after ${duration(work.endedAt! - work.startedAt)}`;
  } else if (work.steps[0]?.tool === RELAY) {
    label = `From ${work.steps[0].text.replace(THREAD_LINK, "$1")}`;
  }
  return (
    // React sets `open` only when `working` changes, so it folds when the work ends; until then, the person's choice
    // to open or fold it stays.
    <details className={working ? "work working" : "work"} open={working}>
      <summary className="work-summary">
        <span>{label}</span>
        {groups.length > 0 ? (
          <span className="disclosure">
            <Icon name="disclosure" />
          </span>
        ) : null}
        {working ? null : <StepStrip steps={work.steps} />}
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
                    <StepPixel steps={steps} />
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

/** The step the agent is at: the tool it calls, a thought, or the words of its answer. */
export function stepTitle(step: Step | undefined): string {
  if (step?.kind === "tool") {
    return toolWords(step.tool!);
  }
  if (step?.kind === "thinking") {
    return "Thinking";
  }
  return step ? "Writing" : "";
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
          <StepPixel steps={[step]} />
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

/** One pixel for each tool call of a finished work, in the gold of the icon's eyes, or `danger` where a call failed. */
function StepStrip({ steps }: { steps: readonly Step[] }) {
  // shortcut: a long work shows only its last 24 calls; open the log for all of them.
  const calls = steps
    .filter((step) => step.kind === "tool" && step.tool !== RELAY)
    .slice(-24);
  return calls.length > 0 ? (
    <span aria-hidden="true" className="step-strip">
      {calls.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps only grow, so their place is their identity
        <i className={stepState([step])} key={index} />
      ))}
    </span>
  ) : null;
}

/** The pixel of tool calls: it runs while one of them runs, and fails when one of them failed. */
function StepPixel({ steps }: { steps: readonly Step[] }) {
  return <i aria-hidden="true" className={`step-pixel ${stepState(steps)}`} />;
}

function stepState(steps: readonly Step[]): "running" | "failed" | "done" {
  if (steps.some((step) => step.running)) {
    return "running";
  }
  return steps.some((step) => step.failed) ? "failed" : "done";
}

function ToolName({ tool }: { tool: string }) {
  return <span className="work-tool-name">{toolWords(tool)}</span>;
}

/** A tool's name as words: `web_search` is Web search. */
export function toolWords(tool: string): string {
  const words = tool.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The time since `since`, counting up each second. */
export function Elapsed({ since }: { since: number }) {
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
