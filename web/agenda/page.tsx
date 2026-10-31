import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";
import type { Reminder, Routine, Suggestion } from "../app/types.ts";
import {
  Badge,
  Button,
  Empty,
  PageSection,
  SettingsCard,
  SettingsRow,
  Switch,
} from "../ui/components.tsx";
import { clockTime, weekdayTime } from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { channelsOf } from "../workspaces/data.ts";
import { PanelHeader } from "../workspaces/shell.tsx";
import {
  type AgendaItem,
  agendaGroups,
  itemId,
  scheduleWords,
  upcomingQuery,
  useAnswerSuggestion,
  useCancelReminder,
  useRoutineEnabled,
} from "./data.ts";

const workspaceRoute = getRouteApi("/signed-in/w/$workspaceId");

/** The names of the workspace's channels, which routine rows show. */
const ChannelNames = createContext<ReadonlyMap<string, string>>(new Map());

/** What Golem runs for the person and what waits for them, in groups from what needs them to what is paused. */
export function UpcomingPage() {
  const { workspaceId } = workspaceRoute.useParams();
  const { data: upcoming } = useQuery(upcomingQuery(workspaceId));
  const groups = upcoming ? agendaGroups(upcoming, Date.now()) : [];
  const { data: channels = [] } = useLiveQuery({
    query: (q) => q.from({ channel: channelsOf(workspaceId) }),
  });
  return (
    <section className="conversation">
      <PanelHeader title="Upcoming" />
      <ChannelNames
        value={new Map(channels.map((channel) => [channel.id, channel.name]))}
      >
        <div className="page">
          <div className="page-content">
            {upcoming && groups.length === 0 ? (
              <Empty icon="clock" title="Nothing upcoming" />
            ) : null}
            {groups.map((group) => (
              <PageSection key={group.title} title={group.title}>
                <SettingsCard>
                  {group.items.map((item) => (
                    <AgendaRow
                      item={item}
                      key={`${item.kind}:${itemId(item)}`}
                      soon={
                        group.title === "Today" || group.title === "Tomorrow"
                      }
                      workspaceId={workspaceId}
                    />
                  ))}
                </SettingsCard>
              </PageSection>
            ))}
          </div>
        </div>
      </ChannelNames>
    </section>
  );
}

/** The suggestions that wait for the person, above the composer of their Golem. */
export function SuggestionCards() {
  const { workspaceId } = workspaceRoute.useParams();
  const suggestions =
    useQuery(upcomingQuery(workspaceId)).data?.suggestions ?? [];
  return suggestions.map((suggestion) => (
    <section aria-label="Suggestion" className="suggestion" key={suggestion.id}>
      <Icon name={suggestion.kind === "routine" ? "play" : "clock"} />
      <div className="settings-text">
        <strong>{suggestion.name}</strong>
        <span>{suggestionWhen(suggestion)}</span>
      </div>
      <SuggestionActions suggestion={suggestion} workspaceId={workspaceId} />
    </section>
  ));
}

function AgendaRow({
  workspaceId,
  item,
  soon,
}: {
  workspaceId: string;
  item: AgendaItem;
  /** Today and Tomorrow show only the time. */
  soon: boolean;
}) {
  const when = (at: number) => (soon ? clockTime(at) : weekdayTime(at));
  switch (item.kind) {
    case "approval":
      return (
        <SettingsRow
          compact
          label={item.approval.text}
          lead={<Icon name="key" />}
        >
          <OpenThread threadId={item.threadId} workspaceId={workspaceId} />
        </SettingsRow>
      );
    case "failed":
      return (
        <RoutineRow
          routine={item.routine}
          when={item.routine.lastRun?.error ?? undefined}
          workspaceId={workspaceId}
        >
          <Badge label="Failed" tone="danger" />
        </RoutineRow>
      );
    case "suggestion":
      return (
        <SettingsRow
          compact
          description={suggestionWhen(item.suggestion)}
          label={item.suggestion.name}
          lead={
            <Icon
              name={item.suggestion.kind === "routine" ? "play" : "clock"}
            />
          }
        >
          <SuggestionActions
            suggestion={item.suggestion}
            workspaceId={workspaceId}
          />
        </SettingsRow>
      );
    case "reminder":
      return (
        <ReminderRow
          reminder={item.reminder}
          when={when(item.reminder.dueAt)}
          workspaceId={workspaceId}
        />
      );
    default:
      return (
        <RoutineRow
          routine={item.routine}
          when={
            item.routine.nextRunAt === null
              ? undefined
              : when(item.routine.nextRunAt)
          }
          workspaceId={workspaceId}
        />
      );
  }
}

/** A routine: its time and channel, a switch that pauses it, and its thread. */
function RoutineRow({
  workspaceId,
  routine,
  when,
  children,
}: {
  workspaceId: string;
  routine: Routine;
  when?: string;
  children?: ReactNode;
}) {
  const channel = useContext(ChannelNames).get(routine.channelId);
  const enabled = useRoutineEnabled(workspaceId);
  return (
    <SettingsRow
      compact
      description={[
        when ?? scheduleWords(routine.schedule),
        channel && `#${channel}`,
      ]
        .filter(Boolean)
        .join(" · ")}
      label={routine.name}
      lead={<Icon name="play" />}
    >
      {children}
      <Switch
        checked={
          enabled.isPending ? enabled.variables.enabled : routine.enabled
        }
        label={`Run ${routine.name}`}
        onChange={(checked) =>
          enabled.mutate({ id: routine.id, enabled: checked })
        }
      />
      {routine.threadId ? (
        <OpenThread threadId={routine.threadId} workspaceId={workspaceId} />
      ) : null}
    </SettingsRow>
  );
}

function ReminderRow({
  workspaceId,
  reminder,
  when,
}: {
  workspaceId: string;
  reminder: Reminder;
  when: string;
}) {
  const cancel = useCancelReminder(workspaceId);
  return (
    <SettingsRow
      compact
      description={when}
      label={reminder.text}
      lead={<Icon name="clock" />}
    >
      <Button
        disabled={cancel.isPending}
        label="Cancel"
        onClick={() => cancel.mutate(reminder.id)}
        size="small"
      />
    </SettingsRow>
  );
}

function OpenThread({
  workspaceId,
  threadId,
}: {
  workspaceId: string;
  threadId: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      icon="forward"
      label="Open thread"
      onClick={() =>
        navigate({
          to: "/w/$workspaceId/t/$threadId",
          params: { workspaceId, threadId },
        })
      }
      size="icon"
      variant="ghost"
    />
  );
}

function SuggestionActions({
  workspaceId,
  suggestion,
}: {
  workspaceId: string;
  suggestion: Suggestion;
}) {
  const answer = useAnswerSuggestion(workspaceId);
  return (
    <>
      <Button
        disabled={answer.isPending}
        label="Decline"
        onClick={() => answer.mutate({ id: suggestion.id, accept: false })}
        size="small"
      />
      <Button
        disabled={answer.isPending}
        label="Accept"
        onClick={() => answer.mutate({ id: suggestion.id, accept: true })}
        size="small"
        variant="primary"
      />
    </>
  );
}

/** A routine's schedule and its first run, or a reminder's time. */
function suggestionWhen(suggestion: Suggestion): string {
  const at = suggestion.at === null ? null : weekdayTime(suggestion.at);
  if (suggestion.schedule === null) {
    return at ?? "";
  }
  const schedule = scheduleWords(suggestion.schedule);
  return at ? `${schedule} · First ${at}` : schedule;
}
