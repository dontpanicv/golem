import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";
import type { Reminder, Routine, Suggestion } from "../app/types.ts";
import {
  Badge,
  Button,
  DayStrip,
  Empty,
  PageSection,
  SettingsCard,
  SettingsRow,
  Switch,
} from "../ui/components.tsx";
import {
  clockTime,
  placeWindow,
  placeWords,
  weekdayTime,
} from "../ui/format.ts";
import { Icon } from "../ui/icon.tsx";
import { topicsOf } from "../workspaces/data.ts";
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

/** The names of the workspace's topics, which routine rows show. */
const TopicNames = createContext<ReadonlyMap<string, string>>(new Map());

/** What Golem runs for the person and what waits for them, in groups from what needs them to what is paused. */
export function UpcomingPage() {
  const { workspaceId } = workspaceRoute.useParams();
  const { data: upcoming } = useQuery(upcomingQuery(workspaceId));
  const groups = upcoming ? agendaGroups(upcoming, Date.now()) : [];
  const { data: topics = [] } = useLiveQuery({
    query: (q) => q.from({ topic: topicsOf(workspaceId) }),
  });
  return (
    <section className="conversation">
      <PanelHeader title="Upcoming" />
      <TopicNames
        value={new Map(topics.map((topic) => [topic.id, topic.name]))}
      >
        <div className="page">
          <div className="page-content">
            {upcoming && groups.length === 0 ? (
              <Empty title="Nothing upcoming" />
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
      </TopicNames>
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
          <OpenChat chatId={item.chatId} workspaceId={workspaceId} />
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
          {item.suggestion.at === null ? null : (
            <DayStrip at={item.suggestion.at} />
          )}
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
          when={
            item.reminder.place && item.reminder.triggeredAt === null
              ? placeWindow(
                  item.reminder.place,
                  item.reminder.notBefore,
                  item.reminder.notAfter
                )
              : when(item.reminder.dueAt)
          }
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

/** A routine: its time and topic, a switch that pauses it, and its chat. */
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
  const topic = useContext(TopicNames).get(routine.topicId);
  const enabled = useRoutineEnabled(workspaceId);
  return (
    <SettingsRow
      compact
      description={[
        when ??
          (routine.place
            ? placeWords(routine.place)
            : scheduleWords(routine.schedule ?? "")),
        topic && `#${topic}`,
      ]
        .filter(Boolean)
        .join(" · ")}
      label={routine.name}
      lead={<Icon name={routine.place ? "place" : "play"} />}
    >
      {routine.nextRunAt === null ? null : <DayStrip at={routine.nextRunAt} />}
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
      {routine.chatId ? (
        <OpenChat chatId={routine.chatId} workspaceId={workspaceId} />
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
      lead={<Icon name={reminder.place ? "place" : "clock"} />}
    >
      {reminder.place && reminder.triggeredAt === null ? null : (
        <DayStrip at={reminder.dueAt} />
      )}
      <Button
        disabled={cancel.isPending}
        label="Cancel"
        onClick={() => cancel.mutate(reminder.id)}
        size="small"
      />
    </SettingsRow>
  );
}

function OpenChat({
  workspaceId,
  chatId,
}: {
  workspaceId: string;
  chatId: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      icon="forward"
      label="Open chat"
      onClick={() =>
        navigate({
          to: "/w/$workspaceId/chat/$chatId",
          params: { workspaceId, chatId },
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
