import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Navigate } from "@tanstack/react-router";
import { Empty } from "../ui/components.tsx";
import {
  chatsOf,
  lastOpened,
  orchestratorQuery,
  topicsOf,
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
        <Empty title="Ask a family member to add you" />
      </section>
    </Shell>
  );
}

const workspaceRoute = getRouteApi("/signed-in/w/$workspaceId/");

/** A workspace opens on the topic or chat this browser had open last, if it still exists, else on the orchestrator. */
export function WorkspaceHome() {
  const { workspaceId } = workspaceRoute.useParams();
  const topics = useLiveQuery({
    query: (q) => q.from({ topic: topicsOf(workspaceId) }),
  });
  const chats = useLiveQuery({
    query: (q) => q.from({ chat: chatsOf(workspaceId) }),
  });
  const orchestrator = useQuery(orchestratorQuery(workspaceId)).data;
  if (!(topics.isReady && chats.isReady && orchestrator)) {
    return null;
  }
  const last = lastOpened();
  if (last?.workspaceId === workspaceId) {
    if (topics.data.some((topic) => topic.id === last.topicId)) {
      return (
        <Navigate
          params={{ workspaceId, topicId: last.topicId! }}
          replace
          to="/w/$workspaceId/topic/$topicId"
        />
      );
    }
    if (
      last.chatId === orchestrator.id ||
      chats.data.some((chat) => chat.id === last.chatId)
    ) {
      return (
        <Navigate
          params={{ workspaceId, chatId: last.chatId! }}
          replace
          to="/w/$workspaceId/chat/$chatId"
        />
      );
    }
  }
  return (
    <Navigate
      params={{ workspaceId, chatId: orchestrator.id }}
      replace
      to="/w/$workspaceId/chat/$chatId"
    />
  );
}

const orchestratorRoute = getRouteApi("/signed-in/w/$workspaceId/orchestrator");

/** The orchestrator's chat; a search result opens one of the workspace's own artifacts here. */
export function OrchestratorPage() {
  const { workspaceId } = orchestratorRoute.useParams();
  const search = orchestratorRoute.useSearch();
  const orchestrator = useQuery(orchestratorQuery(workspaceId)).data;
  return orchestrator ? (
    <Navigate
      params={{ workspaceId, chatId: orchestrator.id }}
      replace
      search={search}
      to="/w/$workspaceId/chat/$chatId"
    />
  ) : null;
}
