import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { WorkingSpinner } from "../ui/components.tsx";

/** A link that opens a thread, and its spinner while the thread's agent works. */
export function ThreadLink({
  workspaceId,
  threadId,
  children,
}: {
  workspaceId: string;
  threadId: string;
  children: ReactNode;
}) {
  return (
    <>
      <Link
        className="thread-link"
        params={{ workspaceId, threadId }}
        to="/w/$workspaceId/t/$threadId"
      >
        {children}
      </Link>
      <WorkingSpinner threadId={threadId} />
    </>
  );
}
