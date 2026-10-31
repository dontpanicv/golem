import { useState } from "react";
import type { Approval, Step, Work } from "../app/types.ts";
import { Button, Mark } from "../ui/components.tsx";
import { showError } from "../ui/toast.tsx";
import { answerApproval } from "./data.ts";
import { Elapsed, toolWords } from "./message.tsx";

/**
 * What the agent of a thread does now, at the top of its composer, so that it stays in view: Golem's face, the step it
 * is at, and how long it has worked, with Stop; and each action that it waits for this person to allow.
 */
export function LiveStatus({
  work,
  running,
  approvals,
  threadId,
  onStop,
}: {
  /** The work of the answer that the agent writes now, once it has one. */
  work: Work | null;
  running: boolean;
  approvals: readonly Approval[];
  threadId: string;
  onStop: () => void;
}) {
  if (!running && approvals.length === 0) {
    return null;
  }
  const waiting = approvals.length > 0;
  const [title, detail] = waiting
    ? ["Waiting for you", ""]
    : now(work?.steps.at(-1));
  return (
    <section aria-label="Golem" aria-live="polite" className="live-status">
      <div className="live-row">
        <Mark mood={waiting ? "waiting" : "working"} size="small" />
        <span className="live-step">
          <span className="shimmer">{title}</span>
          {detail ? <span className="live-detail">{detail}</span> : null}
        </span>
        {work ? (
          <span className="live-time">
            <Elapsed since={work.startedAt} />
          </span>
        ) : null}
        {running ? (
          <Button icon="stop" label="Stop" onClick={onStop} size="tiny" />
        ) : null}
      </div>
      {approvals.map((approval) => (
        <ApprovalRequest
          approval={approval}
          key={approval.id}
          threadId={threadId}
        />
      ))}
    </section>
  );
}

const THREAD_LINK = /\[([^\]\n]+)\]\(thread:[\w-]+\)/g;

/** The step the agent is at, as a title and a detail: a tool call, a thought, or the words of its answer. */
function now(step: Step | undefined): [string, string] {
  if (step?.kind === "tool") {
    // A thread that the call reached shows as its title.
    return [toolWords(step.tool!), step.text.replace(THREAD_LINK, "$1")];
  }
  if (step?.kind === "thinking") {
    return ["Thinking", ""];
  }
  return [step ? "Writing" : "Working", ""];
}

/**
 * An action the agent waits for the person to allow: once, for the rest of the turn on that machine when it allows
 * that, or not.
 */
function ApprovalRequest({
  approval,
  threadId,
}: {
  approval: Approval;
  threadId: string;
}) {
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean, scope?: "once" | "turn") => {
    setBusy(true);
    answerApproval(threadId, approval.id, allow, scope).catch((error) => {
      setBusy(false);
      showError(error);
    });
  };
  return (
    <div className="approval">
      <p>{approval.text}</p>
      <div className="approval-actions">
        <Button
          disabled={busy}
          label="Deny"
          onClick={() => answer(false)}
          size="small"
          variant="danger"
        />
        {approval.allowsTurn ? (
          <Button
            disabled={busy}
            label="Allow for this turn"
            onClick={() => answer(true, "turn")}
            size="small"
          />
        ) : null}
        <Button
          disabled={busy}
          label="Allow"
          onClick={() => answer(true, "once")}
          size="small"
          variant="primary"
        />
      </div>
    </div>
  );
}
