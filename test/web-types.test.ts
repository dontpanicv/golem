import { expect, test } from "bun:test";
import type { Suggestion, Upcoming } from "../src/agenda/agenda.ts";
import type * as Server from "../src/artifacts/artifacts.ts";
import type { MachineSummary, Pairing } from "../src/hands/hands.ts";
import type { Integration } from "../src/integrations/integrations.ts";
import type { LlmStatus, UsageReport } from "../src/llm/llm.ts";
import type { User } from "../src/platform/auth.ts";
import type { Routine, RoutineRun } from "../src/routines/routines.ts";
import type { RecentSearch, SearchResponse } from "../src/search/search.ts";
import type {
  Brief,
  LearnedItem,
  Message,
  SavedFile,
  ThreadMessages,
} from "../src/threads/threads.ts";
import type {
  Channel,
  Member,
  ThreadSummary,
  Workspace,
} from "../src/workspaces/workspaces.ts";
import type * as Web from "../web/app/types.ts";

/** Compiles only when what the server sends fits the web app's copy of the types of docs/api.md. */
type Fits<Sent extends Read, Read> = Sent extends Read ? true : never;

const checks: true[] = [
  true satisfies Fits<User, Web.User>,
  true satisfies Fits<Workspace, Web.Workspace>,
  true satisfies Fits<ThreadSummary, Web.ThreadSummary>,
  true satisfies Fits<Channel, Web.Channel>,
  true satisfies Fits<Member, Web.Member>,
  true satisfies Fits<Brief, Web.Brief>,
  true satisfies Fits<Message, Web.Message>,
  true satisfies Fits<SavedFile, Web.SavedFile>,
  true satisfies Fits<
    ThreadMessages & { thread: ThreadSummary },
    Web.ThreadState
  >,
  true satisfies Fits<SearchResponse, Web.SearchResponse>,
  true satisfies Fits<RecentSearch, Web.RecentSearch>,
  true satisfies Fits<Integration, Web.Integration>,
  true satisfies Fits<Routine, Web.Routine>,
  true satisfies Fits<RoutineRun, Web.RoutineRun>,
  true satisfies Fits<Server.Artifact, Web.Artifact>,
  true satisfies Fits<Server.ArtifactRecord, Web.ArtifactRecord>,
  true satisfies Fits<MachineSummary, Web.Machine>,
  true satisfies Fits<Pairing, Web.Pairing>,
  true satisfies Fits<LlmStatus, Web.LlmStatus>,
  true satisfies Fits<
    Omit<UsageReport, "threads" | "people"> & {
      threads: (UsageReport["threads"][number] & { title: string })[];
      people:
        | (NonNullable<UsageReport["people"]>[number] & { name: string })[]
        | null;
    },
    Web.Usage
  >,
  true satisfies Fits<LearnedItem, Web.Learned>,
  true satisfies Fits<Suggestion, Web.Suggestion>,
  true satisfies Fits<Upcoming, Web.Upcoming>,
];

test("the web app reads the types the server sends", () => {
  // `bun run typecheck` does the work; a type that drifted fails it.
  expect(checks.every(Boolean)).toBe(true);
});
