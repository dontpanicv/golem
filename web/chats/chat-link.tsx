import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { WorkingSpinner } from "../ui/components.tsx";

/** A link that opens a chat, and its spinner while the chat's agent works. */
export function ChatLink({
  workspaceId,
  chatId,
  children,
}: {
  workspaceId: string;
  chatId: string;
  children: ReactNode;
}) {
  return (
    <>
      <Link
        className="chat-link"
        params={{ workspaceId, chatId }}
        to="/w/$workspaceId/chat/$chatId"
      >
        {children}
      </Link>
      <WorkingSpinner chatId={chatId} />
    </>
  );
}
