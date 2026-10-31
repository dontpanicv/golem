import { useState } from "react";
import type { Approval } from "../app/types.ts";
import { Button } from "../ui/components.tsx";
import { showError } from "../ui/toast.tsx";
import { answerApproval } from "./data.ts";

/**
 * An action the agent waits for the person to allow: once, for the rest of the turn on that machine when it allows
 * that, or not. It sits in the transcript after the answer that asks, with its buttons at the start of the line, far
 * from the composer's Send.
 */
export function ApprovalRequest({
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
          label="Allow"
          onClick={() => answer(true, "once")}
          size="small"
          variant="primary"
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
          label="Deny"
          onClick={() => answer(false)}
          size="small"
          variant="danger"
        />
      </div>
    </div>
  );
}
