import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection, eq, useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { request } from "../app/api.ts";
import { keyed } from "../app/collections.ts";
import { queryClient } from "../app/query.ts";
import type { Routine, RoutineOutcome, RoutineRun } from "../app/types.ts";
import { briefQuery } from "../threads/data.ts";
import { AgentText } from "../threads/message.tsx";
import {
  Badge,
  Button,
  Empty,
  Menu,
  PageSection,
  SettingsCard,
  SettingsRow,
  Switch,
} from "../ui/components.tsx";
import { weekdayTime } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { showError, showToast } from "../ui/toast.tsx";
import { channelsOf } from "../workspaces/data.ts";

const OUTCOMES: Record<
  RoutineOutcome,
  { label: string; tone?: "accent" | "success" | "danger" }
> = {
  running: { label: "Running", tone: "accent" },
  quiet: { label: "Quiet" },
  posted: { label: "Posted", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

interface RoutineList {
  readonly routines: Routine[];
  readonly runs: RoutineRun[];
}

function routinesKey(key: string) {
  const [workspaceId] = key.split("/");
  return ["workspaces", workspaceId, "routines", key];
}

function routinesRequest(key: string, signal?: AbortSignal) {
  const [workspaceId, channelId] = key.split("/");
  return request<RoutineList>(
    `/workspaces/${workspaceId}/channels/${channelId}/routines`,
    { signal }
  );
}

/** The routines of a channel, `<workspace id>/<channel id>`. Pausing or deleting one shows at once. */
const routinesOf = keyed((key: string) =>
  createCollection(
    queryCollectionOptions({
      id: `routines:${key}`,
      queryKey: routinesKey(key),
      queryClient,
      queryFn: ({ signal }) => routinesRequest(key, signal),
      select: (list) => list.routines,
      getKey: (routine) => routine.id,
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/routines/${mutation.key}`, {
            method: "PUT",
            body: { enabled: mutation.modified.enabled },
          });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await request(`/routines/${mutation.key}`, { method: "DELETE" });
        }
      },
    })
  )
);

const route = getRouteApi("/signed-in/w/$workspaceId/c/$channelId");

/**
 * A channel's summary and brief, its routines, and their newest runs, under its threads. People create routines by
 * asking an agent; the model writes the summary and the brief from the channel's threads.
 */
export function ChannelDetails() {
  const { workspaceId, channelId } = route.useParams();
  const key = `${workspaceId}/${channelId}`;
  const navigate = useNavigate();
  const { data: channel } = useLiveQuery({
    query: (q) =>
      q
        .from({ channel: channelsOf(workspaceId) })
        .where(({ channel: row }) => eq(row.id, channelId))
        .findOne(),
  });
  const brief = useQuery(briefQuery(workspaceId, channelId)).data?.brief;
  const routines = routinesOf(key);
  const { data: rows = [] } = useLiveQuery({
    query: (q) => q.from({ routine: routines }),
  });
  // The runs come with the routines, in the same response.
  const runs =
    useQuery({
      queryKey: routinesKey(key),
      queryFn: ({ signal }) => routinesRequest(key, signal),
      select: (list) => list.runs,
    }).data ?? [];
  const runNow = async (routine: Routine) => {
    try {
      await request(`/routines/${routine.id}/runs`, { method: "POST" });
      showToast("success", `${routine.name} runs now`);
      await queryClient.invalidateQueries({ queryKey: routinesKey(key) });
    } catch (error) {
      showError(error);
    }
  };
  return (
    <>
      {channel?.summary ? (
        <PageSection title="Summary">
          <p className="page-text">{channel.summary}</p>
        </PageSection>
      ) : null}
      {brief ? (
        <PageSection title="Brief">
          <div className="page-text prose">
            <AgentText
              // The brief's headings sit under the section's own heading.
              text={brief.text.replace(/^#{1,2} /gm, "### ")}
              workspaceId={workspaceId}
            />
          </div>
        </PageSection>
      ) : null}
      <PageSection title="Routines">
        {rows.length > 0 ? (
          <SettingsCard>
            {rows.map((routine) => (
              <SettingsRow
                description={
                  routine.nextRunAt === null
                    ? "Paused"
                    : `Next ${weekdayTime(routine.nextRunAt)}`
                }
                key={routine.id}
                label={routine.name}
                lead={<Icon name="play" />}
              >
                <Switch
                  checked={routine.enabled}
                  label={`Run ${routine.name}`}
                  onChange={(enabled) =>
                    routines
                      .update(routine.id, (draft) => {
                        draft.enabled = enabled;
                      })
                      .isPersisted.promise.catch(showError)
                  }
                />
                <Menu
                  entries={[
                    ...(routine.threadId
                      ? [
                          {
                            kind: "action" as const,
                            label: "Open thread",
                            icon: "compose" as const,
                            onSelect: () =>
                              navigate({
                                to: "/w/$workspaceId/t/$threadId",
                                params: {
                                  workspaceId,
                                  threadId: routine.threadId!,
                                },
                              }),
                          },
                        ]
                      : []),
                    {
                      kind: "action",
                      label: "Run now",
                      icon: "play",
                      onSelect: () => runNow(routine),
                    },
                    {
                      kind: "action",
                      label: "Delete",
                      icon: "trash",
                      onSelect: () =>
                        routines
                          .delete(routine.id)
                          .isPersisted.promise.then(() =>
                            showToast("success", `${routine.name} deleted`)
                          )
                          .catch(showError),
                    },
                  ]}
                  trigger={
                    <Button
                      icon="more"
                      label={`${routine.name} actions`}
                      size="icon"
                      variant="ghost"
                    />
                  }
                />
              </SettingsRow>
            ))}
          </SettingsCard>
        ) : (
          <Empty icon="play" title="No routines yet" />
        )}
      </PageSection>
      <PageSection title="Runs">
        {runs.length > 0 ? (
          <SettingsCard>
            {runs.map((run) => (
              <SettingsRow
                compact
                description={[weekdayTime(run.startedAt), run.error]
                  .filter(Boolean)
                  .join(" · ")}
                key={run.id}
                label={run.routineName}
              >
                <Badge
                  label={OUTCOMES[run.outcome].label}
                  tone={OUTCOMES[run.outcome].tone}
                />
              </SettingsRow>
            ))}
          </SettingsCard>
        ) : (
          <Empty icon="inbox" title="No runs yet" />
        )}
      </PageSection>
    </>
  );
}
