import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Notification } from "../app/types.ts";
import { Button, Empty } from "../ui/components.tsx";
import { day } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import { inboxQuery } from "../workspaces/data.ts";
import { PanelHeader } from "../workspaces/shell.tsx";
import { readNotifications } from "./data.ts";

const route = getRouteApi("/signed-in/w/$workspaceId/inbox");

/** The workspace's notifications, newest first, as Linear's Inbox: a click reads one and opens its chat or topic. */
export function InboxPage() {
  const { workspaceId } = route.useParams();
  const { data: inbox } = useQuery(inboxQuery(workspaceId));
  return (
    <section className="conversation">
      <PanelHeader title="Inbox">
        <Button
          disabled={!inbox?.unread}
          icon="check"
          label="Mark all read"
          onClick={() => readNotifications(workspaceId).catch(showError)}
          size="icon"
          variant="ghost"
        />
      </PanelHeader>
      <div className="page">
        <div className="page-content">
          {inbox?.notifications.length === 0 ? (
            <Empty title="No notifications" />
          ) : (
            <div className="search-results">
              {inbox?.notifications.map((notification) => (
                <InboxRow
                  key={notification.id}
                  notification={notification}
                  workspaceId={workspaceId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function InboxRow({
  workspaceId,
  notification,
}: {
  workspaceId: string;
  notification: Notification;
}) {
  const unread = notification.readAt === null;
  const onClick = () => {
    if (unread) {
      readNotifications(workspaceId, notification.id).catch(showError);
    }
  };
  const body = (
    <>
      <Icon name={notification.chatId ? "compose" : "hash"} />
      <span className="search-text">
        <strong>{notification.title}</strong>
        <span>{notification.text}</span>
      </span>
      <span className="meta">{day(notification.createdAt)}</span>
      {unread ? (
        <span aria-label="Unread" className="unread" role="img" />
      ) : (
        <span aria-hidden className="unread is-read" />
      )}
    </>
  );
  return notification.chatId ? (
    <Link
      className="search-row inbox-row list-row"
      onClick={onClick}
      params={{ workspaceId, chatId: notification.chatId }}
      to="/w/$workspaceId/chat/$chatId"
    >
      {body}
    </Link>
  ) : (
    <Link
      className="search-row inbox-row list-row"
      onClick={onClick}
      params={{ workspaceId, topicId: notification.topicId }}
      to="/w/$workspaceId/topic/$topicId"
    >
      {body}
    </Link>
  );
}
