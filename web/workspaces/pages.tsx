import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Navigate } from "@tanstack/react-router";
import { Empty } from "../ui/components.tsx";
import {
  channelsOf,
  lastOpened,
  orchestratorQuery,
  threadsOf,
  useMe,
} from "./data.ts";
import { FloatingSidebarButton, Shell } from "./shell.tsx";

/** The app opens on the family's workspace; a person who is not a member yet waits for an owner to add them. */
export function Home() {
  const { workspaces } = useMe();
  const last = lastOpened();
  const workspace =
    workspaces.find((candidate) => candidate.id === last?.workspaceId) ??
    workspaces[0];
  return workspace ? (
    <Navigate
      params={{ workspaceId: workspace.id }}
      replace
      to="/w/$workspaceId"
    />
  ) : (
    <Shell workspaceId={undefined}>
      <section className="conversation">
        <FloatingSidebarButton />
        <Empty icon="members" title="Ask a family member to add you" />
      </section>
    </Shell>
  );
}

const workspaceRoute = getRouteApi("/signed-in/w/$workspaceId/");

/** A workspace opens on the channel or thread this browser had open last, if it still exists, else on the orchestrator. */
export function WorkspaceHome() {
  const { workspaceId } = workspaceRoute.useParams();
  const channels = useLiveQuery({
    query: (q) => q.from({ channel: channelsOf(workspaceId) }),
  });
  const threads = useLiveQuery({
    query: (q) => q.from({ thread: threadsOf(workspaceId) }),
  });
  const orchestrator = useQuery(orchestratorQuery(workspaceId)).data;
  if (!(channels.isReady && threads.isReady && orchestrator)) {
    return null;
  }
  const last = lastOpened();
  if (last?.workspaceId === workspaceId) {
    if (channels.data.some((channel) => channel.id === last.channelId)) {
      return (
        <Navigate
          params={{ workspaceId, channelId: last.channelId! }}
          replace
          to="/w/$workspaceId/c/$channelId"
        />
      );
    }
    if (
      last.threadId === orchestrator.id ||
      threads.data.some((thread) => thread.id === last.threadId)
    ) {
      return (
        <Navigate
          params={{ workspaceId, threadId: last.threadId! }}
          replace
          to="/w/$workspaceId/t/$threadId"
        />
      );
    }
  }
  return (
    <Navigate
      params={{ workspaceId, threadId: orchestrator.id }}
      replace
      to="/w/$workspaceId/t/$threadId"
    />
  );
}

const orchestratorRoute = getRouteApi("/signed-in/w/$workspaceId/orchestrator");

/** The orchestrator's thread; a search result opens one of the workspace's own artifacts here. */
export function OrchestratorPage() {
  const { workspaceId } = orchestratorRoute.useParams();
  const search = orchestratorRoute.useSearch();
  const orchestrator = useQuery(orchestratorQuery(workspaceId)).data;
  return orchestrator ? (
    <Navigate
      params={{ workspaceId, threadId: orchestrator.id }}
      replace
      search={search}
      to="/w/$workspaceId/t/$threadId"
    />
  ) : null;
}
