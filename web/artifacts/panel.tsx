import { eq, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Artifact } from "../app/types.ts";
import {
  Badge,
  Button,
  Empty,
  Menu,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { people } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { copy, showError } from "../ui/toast.tsx";
import { artifactsOf, clearData, deleteRecord, recordsQuery } from "./data.ts";

/** The artifacts of a place, newest first; a click opens one in the panel's preview. */
export function ArtifactList({
  placeKey,
  onOpen,
}: {
  placeKey: string;
  onOpen: (artifactId: string) => void;
}) {
  const { data: artifacts = [] } = useLiveQuery({
    query: (q) =>
      q
        .from({ artifact: artifactsOf(placeKey) })
        .orderBy(({ artifact }) => artifact.createdAt, "desc"),
  });
  return (
    <div className="thread-files">
      {artifacts.length > 0 ? (
        <div className="list">
          {artifacts.map((artifact) => (
            <button
              className="list-row"
              key={artifact.id}
              onClick={() => onOpen(artifact.id)}
              type="button"
            >
              <Icon name="artifact" />
              <span className="name">{artifact.title}</span>
              <span className="meta">{people(artifact.visitors)}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty icon="artifact" title="No artifacts yet" />
      )}
    </div>
  );
}

/** The open artifact running, or the data it keeps, with its actions. */
export function ArtifactPreview({
  workspaceId,
  placeKey,
  artifactId,
  onClose,
}: {
  workspaceId: string;
  placeKey: string;
  artifactId: string;
  onClose: () => void;
}) {
  const artifacts = artifactsOf(placeKey);
  const { data: artifact, isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ artifact: artifacts })
        .where(({ artifact: row }) => eq(row.id, artifactId))
        .findOne(),
  });
  const [showData, setShowData] = useState(false);
  const navigate = useNavigate();
  if (!artifact) {
    return (
      <div className="artifact-preview">
        {isReady ? <Empty icon="preview" title="Nothing to preview" /> : null}
      </div>
    );
  }
  const isPublic = artifact.visibility === "public";
  const change = (work: () => { isPersisted: { promise: Promise<unknown> } }) =>
    work().isPersisted.promise.catch(showError);
  return (
    <div className="artifact-preview">
      <div className="artifact-bar">
        <strong className="artifact-title">{artifact.title}</strong>
        <Badge
          label={isPublic ? "Public" : "Members"}
          tone={isPublic ? "accent" : undefined}
        />
        <Button
          aria-pressed={showData}
          label="Data"
          onClick={() => setShowData(!showData)}
          size="small"
          variant="ghost"
        />
        <Menu
          entries={[
            {
              kind: "action",
              label: "Open",
              icon: "preview",
              onSelect: () => window.open(`/a/${artifact.id}`, "_blank"),
            },
            {
              kind: "action",
              label: "Copy link",
              icon: "link",
              onSelect: () => copy(artifact.url),
            },
            {
              kind: "action",
              label: "Open thread",
              icon: "compose",
              onSelect: () =>
                navigate({
                  to: "/w/$workspaceId/t/$threadId",
                  params: { workspaceId, threadId: artifact.threadId },
                }),
            },
            {
              kind: "action",
              label: isPublic ? "Make members only" : "Make public",
              icon: isPublic ? "lock" : "preview",
              onSelect: () =>
                change(() =>
                  artifacts.update(artifact.id, (draft) => {
                    draft.visibility = isPublic ? "members" : "public";
                  })
                ),
            },
            { kind: "separator" },
            {
              kind: "action",
              label: "Clear data",
              icon: "inbox",
              onSelect: () => clearData(artifact.id).catch(showError),
            },
            {
              kind: "action",
              label: "Delete",
              icon: "trash",
              onSelect: () => {
                onClose();
                change(() => artifacts.delete(artifact.id));
              },
            },
          ]}
          trigger={
            <Button
              icon="more"
              label={`${artifact.title} actions`}
              size="icon"
              variant="ghost"
            />
          }
        />
      </div>
      {showData ? (
        <ArtifactData artifact={artifact} />
      ) : (
        <iframe
          className="artifact-frame"
          src={`/a/${artifact.id}?v=${artifact.updatedAt}`}
          title={artifact.title}
        />
      )}
    </div>
  );
}

function ArtifactData({ artifact }: { artifact: Artifact }) {
  const { data: records } = useQuery(recordsQuery(artifact.id));
  if (!records) {
    return <div className="artifact-data" />;
  }
  return (
    <div className="artifact-data">
      {records.length > 0 ? (
        <SettingsCard>
          {records.map((record) => (
            <SettingsRow
              compact
              description={`${record.visitor ? (record.name ?? "Visitor") : "Shared"} · ${JSON.stringify(record.value).slice(0, 200)}`}
              key={record.id}
              label={record.key}
            >
              <Button
                icon="trash"
                label={`Delete ${record.key}`}
                onClick={() =>
                  deleteRecord(artifact.id, record.id).catch(showError)
                }
                size="icon"
                variant="ghost"
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      ) : (
        <Empty icon="inbox" title="No data yet" />
      )}
    </div>
  );
}
