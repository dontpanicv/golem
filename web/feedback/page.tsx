import { useLiveQuery } from "@tanstack/react-db";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Feedback } from "../app/types.ts";
import { Button, Empty } from "../ui/components.tsx";
import { day } from "../ui/format.ts";
import { Icon, type IconName } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import { PanelHeader } from "../workspaces/shell.tsx";
import { feedbackOf } from "./data.ts";

const route = getRouteApi("/signed-in/w/$workspaceId/feedback");

const KINDS: Record<Feedback["kind"], { label: string; icon: IconName }> = {
  error: { label: "Error", icon: "info" },
  missing: { label: "Missing", icon: "plus" },
  better: { label: "Better way", icon: "forward" },
};

/** What the agents reported about Golem, newest first; a report opens its thread when the owner sees it. */
export function FeedbackPage() {
  const { workspaceId } = route.useParams();
  const { data: reports = [], isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ feedback: feedbackOf(workspaceId) })
        .orderBy(({ feedback }) => feedback.createdAt, "desc"),
  });
  return (
    <section className="conversation">
      <PanelHeader title="Feedback" />
      <div className="page">
        <div className="page-content">
          {isReady && reports.length === 0 ? (
            <Empty title="No feedback" />
          ) : (
            <div className="search-results">
              {reports.map((feedback) => (
                <FeedbackRow
                  feedback={feedback}
                  key={feedback.id}
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

function FeedbackRow({
  workspaceId,
  feedback,
}: {
  workspaceId: string;
  feedback: Feedback;
}) {
  const kind = KINDS[feedback.kind];
  const body = (
    <>
      <Icon name={kind.icon} />
      <span className="search-text">
        <strong>{feedback.summary}</strong>
        <span>
          {feedback.tool ? `${kind.label} · ${feedback.tool}` : kind.label}
        </span>
        <span>{feedback.detail}</span>
      </span>
      <span className="meta">{day(feedback.createdAt)}</span>
    </>
  );
  return (
    <div className="file-row">
      {feedback.threadId ? (
        <Link
          className="search-row list-row"
          params={{ workspaceId, threadId: feedback.threadId }}
          to="/w/$workspaceId/t/$threadId"
        >
          {body}
        </Link>
      ) : (
        <div className="search-row list-row">{body}</div>
      )}
      <Button
        icon="check"
        label="Dismiss"
        onClick={() =>
          feedbackOf(workspaceId)
            .delete(feedback.id)
            .isPersisted.promise.catch(showError)
        }
        size="icon"
        variant="ghost"
      />
    </div>
  );
}
