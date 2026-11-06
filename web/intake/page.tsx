import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FollowingChange, FollowingCheck } from "../app/types.ts";
import { Button, Empty, PageSection } from "../ui/components.tsx";
import { weekdayTime } from "../ui/format.ts";
import { showError } from "../ui/toast.tsx";
import { PanelHeader } from "../workspaces/shell.tsx";
import { changeFollowing, followingDetailQuery, followingOf } from "./data.ts";

const route = getRouteApi("/signed-in/w/$workspaceId/following");

/** What Golem follows for this person, with evidence and corrections beside the selected matter. */
export function FollowingPage() {
  const { workspaceId } = route.useParams();
  const [history, setHistory] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { data: checks = [], isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ check: followingOf(workspaceId) })
        .orderBy(({ check }) => check.updatedAt, "desc"),
  });
  const rows = checks.filter((check) => (check.state !== "open") === history);
  const selectedCheck = checks.find((each) => each.id === selected);
  return (
    <section className="conversation">
      <PanelHeader title="Following" />
      <div className="following-tabs">
        <Button
          label="Following"
          onClick={() => setHistory(false)}
          variant={history ? "ghost" : "primary"}
        />
        <Button
          label="History"
          onClick={() => setHistory(true)}
          variant={history ? "primary" : "ghost"}
        />
      </div>
      <div className="following-layout">
        <div className="following-list">
          {isReady && rows.length === 0 ? (
            <Empty
              icon="check"
              title={history ? "No history" : "Nothing to follow"}
            />
          ) : null}
          {rows.map((row) => (
            <button
              aria-pressed={row.id === selected}
              className="search-row list-row"
              key={row.id}
              onClick={() => setSelected(row.id)}
              type="button"
            >
              <span className="search-text">
                <strong>{row.text}</strong>
                <span>{stateLabel(row.state)}</span>
                {row.explicitTime ? (
                  <span>Stated date · {weekdayTime(row.checkAt)}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
        {selectedCheck ? (
          <CheckDetail
            check={selectedCheck}
            key={selectedCheck.id}
            workspaceId={workspaceId}
          />
        ) : (
          <div className="following-detail">
            <Empty icon="search" title="Select a matter" />
          </div>
        )}
      </div>
    </section>
  );
}

function CheckDetail({
  workspaceId,
  check,
}: {
  workspaceId: string;
  check: FollowingCheck;
}) {
  const query = useQuery(followingDetailQuery(workspaceId, check.id));
  const [quote, setQuote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (query.data && check.revision !== query.data.check.revision) {
      query.refetch();
    }
  }, [check.revision, query.data, query.refetch]);
  const detail = query.data;
  const act = async (action: FollowingChange["action"], text: string) => {
    setBusy(true);
    try {
      await changeFollowing(workspaceId, detail?.check ?? check, action, text);
      setQuote("");
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  if (query.error) {
    return (
      <div className="following-detail" role="alert">
        {query.error.message}
        <Button label="Reload" onClick={() => query.refetch()} />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="following-detail" role="status">
        Loading…
      </div>
    );
  }
  const current = detail.check;
  return (
    <div className="following-detail">
      <PageSection title={current.text}>
        <p>{stateLabel(current.state)}</p>
        {current.explicitTime ? (
          <p>Stated date · {weekdayTime(current.checkAt)}</p>
        ) : null}
        {current.state === "open" ? (
          <p>Next review · {weekdayTime(current.reviewAt)}</p>
        ) : null}
        <p>Last change · {weekdayTime(current.updatedAt)}</p>
        {current.threadId ? (
          <Link
            params={{ workspaceId, threadId: current.threadId }}
            to="/w/$workspaceId/t/$threadId"
          >
            Open discussion
          </Link>
        ) : null}
        <div className="following-actions">
          {current.state === "open" ? (
            <>
              <Button
                disabled={busy}
                label="Handled"
                onClick={() => act("handled", "Handled")}
              />
              <Button
                disabled={busy}
                label="Stop following"
                onClick={() => act("stop", "Stop following this matter")}
              />
            </>
          ) : (
            <Button
              disabled={busy}
              label="Reopen"
              onClick={() => act("reopen", "Follow this matter again")}
            />
          )}
          {detail.history[0]?.previous ? (
            <Button
              disabled={busy}
              label="Undo last change"
              onClick={() => act("undo", "Undo the last change")}
            />
          ) : null}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            act("correct", quote);
          }}
        >
          <label className="field">
            Correct
            <textarea
              className="input multiline"
              disabled={busy}
              maxLength={8000}
              onChange={(event) => setQuote(event.target.value)}
              rows={3}
              value={quote}
            />
          </label>
          <Button
            disabled={busy || !quote.trim()}
            label={busy ? "Saving…" : "Apply correction"}
            type="submit"
          />
        </form>
      </PageSection>
      <PageSection title="Evidence">
        {detail.evidence.map((evidence) => (
          <details className="following-evidence" key={evidence.id}>
            <summary>
              {evidence.source} · {weekdayTime(evidence.at)}
            </summary>
            {evidence.url?.startsWith("https://") ? (
              <a href={evidence.url} rel="noreferrer" target="_blank">
                Open source
              </a>
            ) : null}
            <pre>{evidence.text}</pre>
            <p>{evidence.attachments?.map((file) => file.name).join(" · ")}</p>
          </details>
        ))}
      </PageSection>
      <PageSection title="History">
        {detail.history.map((revision) => (
          <details className="following-evidence" key={revision.id}>
            <summary>
              {revision.quote ?? "Golem review"} · {weekdayTime(revision.at)}
            </summary>
            {revision.previous ? (
              <p>
                Before · {stateLabel(revision.previous.state)} ·{" "}
                {revision.previous.text}
              </p>
            ) : null}
            <p>
              After · {stateLabel(revision.current.state)} ·{" "}
              {revision.current.text}
            </p>
            {revision.current.explicitTime ? (
              <p>Stated date · {weekdayTime(revision.current.checkAt)}</p>
            ) : null}
          </details>
        ))}
      </PageSection>
    </div>
  );
}

function stateLabel(state: FollowingCheck["state"]): string {
  return { open: "Following", resolved: "Handled", stopped: "Stopped" }[state];
}
