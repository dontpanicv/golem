import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { request } from "../app/api.ts";
import type { Usage, UsageSource, UsageTotals } from "../app/types.ts";
import {
  Avatar,
  Empty,
  Mark,
  SettingsCard,
  SettingsRow,
  Tooltip,
  WorkingSpinner,
} from "../ui/components.tsx";
import { day } from "../ui/format.ts";

const DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const SOURCES: Record<UsageSource, string> = {
  thread: "Channel threads",
  orchestrator: "Golem",
  routine: "Routines",
  reminder: "Reminders",
  background: "Background work",
};

function usageQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspaces", workspaceId, "usage"],
    queryFn: ({ signal }) =>
      request<Usage>(`/workspaces/${workspaceId}/usage?days=${DAYS}`, {
        signal,
      }),
  });
}

/** The model use of the last 30 days: the totals, a bar for each day, and where the tokens went. */
export function UsageSection({ workspaceId }: { workspaceId: string }) {
  const { data: usage } = useQuery(usageQuery(workspaceId));
  if (!usage) {
    return <SettingsCard>{null}</SettingsCard>;
  }
  if (tokens(usage.total) === 0) {
    return <Empty icon="clock" title="No usage yet" />;
  }
  const { total } = usage;
  const read = total.input + total.cacheRead;
  return (
    <>
      <SettingsCard>
        <SettingsRow label="Tokens">{count(tokens(total))}</SettingsRow>
        <SettingsRow label="Cost at API prices">
          {dollars(total.cost)}
        </SettingsRow>
        <SettingsRow label="Cache rate">
          {percent(read === 0 ? 0 : total.cacheRead / read)}
        </SettingsRow>
        <DayBars days={usage.days} />
      </SettingsCard>
      <UsageRows
        rows={usage.sources.map((row) => ({
          ...row,
          key: row.source,
          label: SOURCES[row.source],
        }))}
        title="By source"
      />
      <UsageRows
        rows={usage.models.map((row) => ({
          ...row,
          key: row.model,
          label: row.model,
        }))}
        title="By model"
      />
      <UsageRows
        rows={usage.threads.map((row) => ({
          ...row,
          key: row.threadId,
          label: (
            <>
              <Link
                className="thread-link"
                params={{ workspaceId, threadId: row.threadId }}
                to="/w/$workspaceId/t/$threadId"
              >
                {row.title}
              </Link>
              <WorkingSpinner threadId={row.threadId} />
            </>
          ),
        }))}
        title="Top threads"
      />
      {usage.people ? (
        <UsageRows
          rows={usage.people.map((row) => ({
            ...row,
            key: row.userId,
            label: row.name,
            lead: row.userId ? <Avatar name={row.name} /> : <Mark />,
          }))}
          title="By person"
        />
      ) : null}
    </>
  );
}

/** One bar for each of the last 30 UTC days, as high as its tokens against the busiest day. */
function DayBars({ days }: { days: Usage["days"] }) {
  const byDay = new Map(days.map((row) => [row.day, row]));
  const today = Date.now();
  const bars = Array.from({ length: DAYS }, (_, index) => {
    const time = today - (DAYS - 1 - index) * DAY;
    const row = byDay.get(new Date(time).toISOString().slice(0, 10));
    return { time, row, tokens: row ? tokens(row) : 0 };
  });
  const most = Math.max(...bars.map((bar) => bar.tokens), 1);
  return (
    <div className="usage-days">
      {bars.map((bar) => (
        <Tooltip
          key={bar.time}
          label={`${day(bar.time)}: ${count(bar.tokens)} tokens, ${dollars(bar.row?.cost ?? 0)}`}
        >
          <span className="usage-day">
            <span style={{ height: `${(bar.tokens / most) * 100}%` }} />
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function UsageRows({
  title,
  rows,
}: {
  title: string;
  rows: (UsageTotals & {
    key: string;
    label: React.ReactNode;
    lead?: React.ReactNode;
  })[];
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <>
      <h3>{title}</h3>
      <SettingsCard>
        {rows.map((row) => (
          <SettingsRow
            compact
            description={`${count(tokens(row))} tokens`}
            key={row.key}
            label={row.label}
            lead={row.lead}
          >
            {dollars(row.cost)}
          </SettingsRow>
        ))}
      </SettingsCard>
    </>
  );
}

function tokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

const COUNT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** 1.2M */
function count(value: number): string {
  return COUNT.format(value);
}

/** $12.40, or $0.042 below a dollar. */
function dollars(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  });
}

/** 64% */
function percent(value: number): string {
  return value.toLocaleString("en-GB", { style: "percent" });
}
