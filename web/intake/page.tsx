import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { type ReactNode, useDeferredValue, useEffect, useState } from "react";
import type {
  FollowingChange,
  FollowingCheck,
  FollowingOverview,
  IntakeEvidence,
  IntakeKept,
  IntakeUpdate,
} from "../app/types.ts";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  PageSection,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { weekdayTime } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";
import { PanelHeader } from "../workspaces/shell.tsx";
import {
  changeFollowing,
  changeUpdate,
  followingDetailQuery,
  followingOf,
  overviewQuery,
  sendFeedback,
} from "./data.ts";

const route = getRouteApi("/signed-in/w/$workspaceId/following");

/** The kept observations that show before "Show all". */
const KEPT_ROWS = 15;

type Selected =
  | { kind: "update"; id: string }
  | { kind: "check"; id: string }
  | { kind: "kept"; id: string }
  | { kind: "source"; id: string };

/**
 * All that Golem holds for the person from the accounts it reads: the thread updates that wait, the matters it follows,
 * its sources, what it keeps, and what it did. Each row opens its detail, where the person gives feedback.
 */
export function FollowingPage() {
  const { workspaceId } = route.useParams();
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const [selected, setSelected] = useState<Selected | null>(null);
  const { data: overview } = useQuery(overviewQuery(workspaceId, query));
  const { data: checks = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ check: followingOf(workspaceId) })
        .orderBy(({ check }) => check.updatedAt, "desc"),
  });
  const updates = overview?.updates ?? [];
  const waiting = updates.filter(
    (update) => update.deliveredAt === null && update.cancelledAt === null
  );
  const open = checks.filter((check) => check.state === "open");
  const history = [
    ...updates
      .filter((update) => !waiting.includes(update))
      .map((update) => ({
        at: update.deliveredAt ?? update.cancelledAt!,
        row: (
          <UpdateRow
            key={update.id}
            onOpen={() => setSelected({ kind: "update", id: update.id })}
            update={update}
          />
        ),
      })),
    ...checks
      .filter((check) => check.state !== "open")
      .map((check) => ({
        at: check.updatedAt,
        row: (
          <CheckRow
            check={check}
            key={check.id}
            onOpen={() => setSelected({ kind: "check", id: check.id })}
          />
        ),
      })),
  ].toSorted((a, b) => b.at - a.at);
  const close = () => setSelected(null);
  return (
    <section className="conversation">
      <PanelHeader title="Following" />
      <div className="page">
        <div className="page-content">
          {overview && overview.sources.length === 0 ? (
            <Empty icon="inbox" title="Golem reads no account for you" />
          ) : null}
          {waiting.length > 0 ? (
            <PageSection title="Waiting">
              <SettingsCard>
                {waiting.map((update) => (
                  <UpdateRow
                    key={update.id}
                    onOpen={() =>
                      setSelected({ kind: "update", id: update.id })
                    }
                    update={update}
                  />
                ))}
              </SettingsCard>
            </PageSection>
          ) : null}
          {open.length > 0 ? (
            <PageSection title="Following">
              <SettingsCard>
                {open.map((check) => (
                  <CheckRow
                    check={check}
                    key={check.id}
                    onOpen={() => setSelected({ kind: "check", id: check.id })}
                  />
                ))}
              </SettingsCard>
            </PageSection>
          ) : null}
          {overview && overview.sources.length > 0 ? (
            <>
              <SourcesSection
                onOpen={(id) => setSelected({ kind: "source", id })}
                overview={overview}
              />
              <KeptSection
                kept={overview.kept}
                onOpen={(id) => setSelected({ kind: "kept", id })}
                onSearch={setSearch}
                search={search}
              />
            </>
          ) : null}
          {history.length > 0 ? (
            <PageSection title="Done">
              <SettingsCard>{history.map((each) => each.row)}</SettingsCard>
            </PageSection>
          ) : null}
          {overview && overview.feedback.length > 0 ? (
            <PageSection title="Your feedback">
              <SettingsCard>
                {overview.feedback.map((feedback) => (
                  <SettingsRow
                    compact
                    description={`${weekdayTime(feedback.createdAt)} · ${line(feedback.about)}`}
                    key={feedback.id}
                    label={feedback.quote}
                  />
                ))}
              </SettingsCard>
            </PageSection>
          ) : null}
        </div>
      </div>
      {overview && selected ? (
        <SelectedDialog
          checks={checks}
          onClose={close}
          overview={overview}
          selected={selected}
          workspaceId={workspaceId}
        />
      ) : null}
    </section>
  );
}

function SourcesSection({
  overview,
  onOpen,
}: {
  overview: FollowingOverview;
  onOpen: (id: string) => void;
}) {
  return (
    <PageSection title="Sources">
      <SettingsCard>
        {overview.sources.map((source) => (
          <SettingsRow
            compact
            description={source.error ?? sourceState(source)}
            key={source.id}
            label={source.name}
            lead={<Icon name="inbox" />}
            onClick={() => onOpen(source.id)}
          >
            {source.error ? <Badge label="Error" tone="danger" /> : null}
          </SettingsRow>
        ))}
      </SettingsCard>
    </PageSection>
  );
}

function KeptSection({
  kept,
  search,
  onSearch,
  onOpen,
}: {
  kept: readonly IntakeKept[];
  search: string;
  onSearch: (search: string) => void;
  onOpen: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  return (
    <PageSection title="Kept">
      <input
        aria-label="Search what Golem keeps"
        className="input"
        onChange={(event) => onSearch(event.target.value)}
        placeholder="Search mail, messages, and notes that Golem keeps"
        type="search"
        value={search}
      />
      {kept.length > 0 ? (
        <SettingsCard>
          {(all ? kept : kept.slice(0, KEPT_ROWS)).map((item) => (
            <KeptRow item={item} key={item.id} onOpen={() => onOpen(item.id)} />
          ))}
        </SettingsCard>
      ) : (
        <Empty icon="search" title="Nothing found" />
      )}
      {!all && kept.length > KEPT_ROWS ? (
        <Button
          label={`Show all ${kept.length}`}
          onClick={() => setAll(true)}
          variant="ghost"
        />
      ) : null}
    </PageSection>
  );
}

function UpdateRow({
  update,
  onOpen,
}: {
  update: IntakeUpdate;
  onOpen: () => void;
}) {
  return (
    <SettingsRow
      compact
      description={`${updateState(update)} · ${line(message(update.body))}`}
      label={updateTitle(update)}
      lead={<Icon name={update.deliveredAt ? "check" : "clock"} />}
      onClick={onOpen}
    >
      {update.notice ? <Badge label="Notifies" tone="accent" /> : null}
    </SettingsRow>
  );
}

function CheckRow({
  check,
  onOpen,
}: {
  check: FollowingCheck;
  onOpen: () => void;
}) {
  return (
    <SettingsRow
      compact
      description={checkState(check)}
      label={line(check.text)}
      lead={<Icon name={check.state === "open" ? "search" : "check"} />}
      onClick={onOpen}
    />
  );
}

function KeptRow({ item, onOpen }: { item: IntakeKept; onOpen: () => void }) {
  return (
    <SettingsRow
      compact
      description={`${weekdayTime(item.at)} · ${line(item.text)}`}
      label={sourceName(item)}
      lead={<Icon name={item.fromOwner ? "send" : "inbox"} />}
      onClick={onOpen}
    >
      <Badge
        label={
          { thread: "In thread", filed: "Filed", context: "Context" }[
            item.outcome
          ]
        }
        tone={item.outcome === "context" ? undefined : "success"}
      />
    </SettingsRow>
  );
}

function SelectedDialog({
  workspaceId,
  overview,
  checks,
  selected,
  onClose,
}: {
  workspaceId: string;
  overview: FollowingOverview;
  checks: readonly FollowingCheck[];
  selected: Selected;
  onClose: () => void;
}) {
  const props = { onClose, overview, workspaceId };
  switch (selected.kind) {
    case "check": {
      const check = checks.find((each) => each.id === selected.id);
      return check ? (
        <CheckDialog
          check={check}
          onClose={onClose}
          workspaceId={workspaceId}
        />
      ) : null;
    }
    case "update": {
      const update = overview.updates.find((each) => each.id === selected.id);
      return update ? <UpdateDialog {...props} update={update} /> : null;
    }
    case "kept": {
      const item = overview.kept.find((each) => each.id === selected.id);
      return item ? <KeptDialog {...props} item={item} /> : null;
    }
    default: {
      const source = overview.sources.find((each) => each.id === selected.id);
      return source ? <SourceDialog {...props} source={source} /> : null;
    }
  }
}

interface DialogProps {
  workspaceId: string;
  overview: FollowingOverview;
  onClose: () => void;
}

function UpdateDialog({
  update,
  ...props
}: DialogProps & { update: IntakeUpdate }) {
  const waits = update.deliveredAt === null && update.cancelledAt === null;
  return (
    <FeedbackDialog
      {...props}
      target={`update:${update.id}`}
      title={updateTitle(update)}
    >
      <p>{updateState(update)}</p>
      {update.notice ? (
        <p>Golem will also notify you: {update.notice}</p>
      ) : null}
      <p className="following-text">{message(update.body)}</p>
      <div className="following-actions">
        {waits ? (
          <UpdateActions update={update} workspaceId={props.workspaceId} />
        ) : null}
        <OpenThread
          threadId={update.threadId}
          workspaceId={props.workspaceId}
        />
      </div>
      <Sources evidence={update.evidence} />
    </FeedbackDialog>
  );
}

function KeptDialog({ item, ...props }: DialogProps & { item: IntakeKept }) {
  return (
    <FeedbackDialog
      {...props}
      target={`item:${item.id}`}
      title={sourceName(item)}
    >
      <p>
        {weekdayTime(item.at)} · {keptWhere(item)}
      </p>
      <p className="following-text">{item.text}</p>
      <Attachments evidence={item} />
      <div className="following-actions">
        <OpenThread threadId={item.threadId} workspaceId={props.workspaceId} />
        <OpenSource url={item.url} />
      </div>
    </FeedbackDialog>
  );
}

function SourceDialog({
  source,
  ...props
}: DialogProps & { source: FollowingOverview["sources"][number] }) {
  return (
    <FeedbackDialog
      {...props}
      target={`source:${source.id}`}
      title={source.name}
    >
      <p>{sourceState(source)}</p>
      {source.error ? <p role="alert">{source.error}</p> : null}
    </FeedbackDialog>
  );
}

/** A dialog whose form sends the person's feedback on `target`, after its earlier feedback. */
function FeedbackDialog({
  workspaceId,
  overview,
  target,
  title,
  onClose,
  children,
}: {
  workspaceId: string;
  overview: FollowingOverview;
  target: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const earlier = overview.feedback.filter((each) => each.target === target);
  return (
    <Dialog
      busy={busy}
      onClose={onClose}
      onSubmit={async (form) => {
        const quote = String(form.get("quote") ?? "").trim();
        if (!quote) {
          return;
        }
        setBusy(true);
        try {
          await sendFeedback(workspaceId, target, quote);
          onClose();
        } catch (error) {
          showError(error);
        } finally {
          setBusy(false);
        }
      }}
      open
      submit={busy ? "Sending…" : "Send feedback"}
      title={title}
    >
      {children}
      {earlier.map((feedback) => (
        <p key={feedback.id}>
          You said {weekdayTime(feedback.createdAt)}: {feedback.quote}
        </p>
      ))}
      <label className="field">
        Feedback
        <textarea
          className="input multiline"
          maxLength={8000}
          name="quote"
          placeholder="What should Golem do differently?"
          rows={3}
        />
      </label>
    </Dialog>
  );
}

function UpdateActions({
  workspaceId,
  update,
}: {
  workspaceId: string;
  update: IntakeUpdate;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (action: "now" | "cancel") => {
    setBusy(true);
    try {
      await changeUpdate(workspaceId, update.id, action);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {update.attention === "brief" ? (
        <Button disabled={busy} label="Send now" onClick={() => act("now")} />
      ) : null}
      <Button
        disabled={busy}
        label="Don't send"
        onClick={() => act("cancel")}
      />
    </>
  );
}

function CheckDialog({
  workspaceId,
  check,
  onClose,
}: {
  workspaceId: string;
  check: FollowingCheck;
  onClose: () => void;
}) {
  const query = useQuery(followingDetailQuery(workspaceId, check.id));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (query.data && check.revision !== query.data.check.revision) {
      query.refetch();
    }
  }, [check.revision, query.data, query.refetch]);
  const detail = query.data;
  const act = async (action: FollowingChange["action"], quote: string) => {
    setBusy(true);
    try {
      await changeFollowing(workspaceId, detail?.check ?? check, action, quote);
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const current = detail?.check ?? check;
  return (
    <Dialog
      busy={busy}
      onClose={onClose}
      onSubmit={async (form) => {
        const quote = String(form.get("quote") ?? "").trim();
        if (quote && (await act("correct", quote))) {
          onClose();
        }
      }}
      open
      submit={busy ? "Saving…" : "Correct"}
      title={current.text}
    >
      <p>{checkState(current)}</p>
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
            label="Follow again"
            onClick={() => act("reopen", "Follow this matter again")}
          />
        )}
        {detail?.history[0]?.previous ? (
          <Button
            disabled={busy}
            label="Undo last change"
            onClick={() => act("undo", "Undo the last change")}
          />
        ) : null}
        <OpenThread threadId={current.threadId} workspaceId={workspaceId} />
      </div>
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {detail ? <Sources evidence={detail.evidence} /> : null}
      {detail?.history.map((revision) => (
        <p key={revision.id}>
          {weekdayTime(revision.at)} · {revision.quote ?? "Golem review"} ·{" "}
          {stateLabel(revision.current.state)}
        </p>
      ))}
      <label className="field">
        Correction
        <textarea
          className="input multiline"
          maxLength={8000}
          name="quote"
          placeholder="What is still open, or what is wrong?"
          rows={3}
        />
      </label>
    </Dialog>
  );
}

function Sources({ evidence }: { evidence: readonly IntakeEvidence[] }) {
  return evidence.map((each) => (
    <details className="following-source" key={each.id}>
      <summary>
        {sourceName(each)} · {weekdayTime(each.at)}
      </summary>
      <p className="following-text">{each.text}</p>
      <Attachments evidence={each} />
      <OpenSource url={each.url} />
    </details>
  ));
}

function Attachments({ evidence }: { evidence: IntakeEvidence }) {
  return evidence.attachments?.length ? (
    <p>{evidence.attachments.map((file) => file.name).join(" · ")}</p>
  ) : null;
}

function OpenThread({
  workspaceId,
  threadId,
}: {
  workspaceId: string;
  threadId: string | null;
}) {
  return threadId ? (
    <Link
      className="button"
      params={{ workspaceId, threadId }}
      to="/w/$workspaceId/t/$threadId"
    >
      Open thread
    </Link>
  ) : null;
}

function OpenSource({ url }: { url: string | null }) {
  return url?.startsWith("https://") ? (
    <a className="button" href={url} rel="noreferrer" target="_blank">
      Open source
    </a>
  ) : null;
}

function sourceState(source: FollowingOverview["sources"][number]): string {
  return `${source.readAt ? `Read until ${weekdayTime(source.readAt)}` : "Not read yet"} · ${source.kept} kept`;
}

function updateTitle(update: IntakeUpdate): string {
  return update.threadTitle ?? `New thread: ${update.newThread ?? "untitled"}`;
}

function updateState(update: IntakeUpdate): string {
  if (update.deliveredAt) {
    return `Posted ${weekdayTime(update.deliveredAt)}`;
  }
  if (update.cancelledAt) {
    return `Not sent · ${weekdayTime(update.cancelledAt)}`;
  }
  return update.attention === "brief"
    ? "Waits for the 08:00 review"
    : "Posts within a minute";
}

function checkState(check: FollowingCheck): string {
  if (check.state !== "open") {
    return `${stateLabel(check.state)} · ${weekdayTime(check.updatedAt)}`;
  }
  return check.explicitTime
    ? `Due ${weekdayTime(check.checkAt)}`
    : `Next look ${weekdayTime(check.reviewAt)}`;
}

function stateLabel(state: FollowingCheck["state"]): string {
  return { open: "Following", resolved: "Handled", stopped: "Stopped" }[state];
}

function keptWhere(item: IntakeKept): string {
  if (item.outcome === "thread") {
    return `In ${item.place}`;
  }
  return item.outcome === "filed" ? `Filed in ${item.place}` : "Context";
}

/** "Mail (a@b.c); Balcony; Alice" reads as "Alice · Balcony". */
function sourceName(evidence: IntakeEvidence): string {
  const [, chat, sender] = evidence.source.split("; ");
  return [sender, chat].filter(Boolean).join(" · ") || evidence.source;
}

/** An update's message, without the source links after it. */
function message(body: string): string {
  const end = body.lastIndexOf("\n\n");
  return end === -1 ? body : body.slice(0, end);
}

function line(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}
