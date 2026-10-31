import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { signOut } from "../accounts/login.tsx";
import { request } from "../app/api.ts";
import { MachinesSection } from "../hands/machines.tsx";
import { IntegrationsSection } from "../integrations/section.tsx";
import { LlmCard, llmQuery } from "../llm/card.tsx";
import { UsageSection } from "../llm/usage.tsx";
import { LearnedSection } from "../threads/learned.tsx";
import {
  Avatar,
  Button,
  PageContent,
  PageSection,
  SettingsCard,
  SettingsRow,
} from "../ui/components.tsx";
import { showError, showToast } from "../ui/toast.tsx";
import { lastOpened, useMe } from "../workspaces/data.ts";
import {
  FactsSection,
  MembersSection,
  WorkspaceSection,
} from "../workspaces/settings.tsx";
import { FloatingSidebarButton, Shell } from "../workspaces/shell.tsx";

const workspaceRoute = getRouteApi("/signed-in/w/$workspaceId/settings");

/** A workspace's facts, members, and name, most used first; each person's machines and integrations are in Settings. */
export function WorkspaceSettingsPage() {
  const { workspaceId } = workspaceRoute.useParams();
  const workspace = useMe().workspaces.find(
    (candidate) => candidate.id === workspaceId
  )!;
  return (
    <section className="conversation">
      <FloatingSidebarButton />
      <PageContent title={workspace.name}>
        <PageSection title="Facts">
          <FactsSection workspaceId={workspaceId} />
        </PageSection>
        <PageSection title="Members">
          <MembersSection workspace={workspace} />
        </PageSection>
        {workspace.role === "owner" ? (
          <PageSection title="Workspace">
            <WorkspaceSection workspace={workspace} />
          </PageSection>
        ) : null}
      </PageContent>
    </section>
  );
}

/** The person's integrations, what Golem learned, machines, usage, the LLM provider, and the account, most used first. The sidebar keeps the last workspace, so settings feel like part of the app. */
export function SettingsPage() {
  const { user, workspaces } = useMe();
  const { data: llm } = useQuery(llmQuery);
  const last = lastOpened();
  const workspace =
    workspaces.find((candidate) => candidate.id === last?.workspaceId) ??
    workspaces[0];
  return (
    <Shell workspaceId={workspace?.id}>
      <section className="conversation">
        <FloatingSidebarButton />
        <PageContent title="Settings">
          {workspace ? (
            <>
              <PageSection title="Integrations">
                <IntegrationsSection workspaceId={workspace.id} />
              </PageSection>
              <PageSection title="What Golem learned">
                <LearnedSection workspaceId={workspace.id} />
              </PageSection>
              <PageSection title="Machines">
                <MachinesSection workspaceId={workspace.id} />
              </PageSection>
              <PageSection title="Usage">
                <UsageSection workspaceId={workspace.id} />
              </PageSection>
            </>
          ) : null}
          <PageSection title="LLM provider">
            <LlmCard />
          </PageSection>
          {llm?.owner ? (
            <PageSection title="Server">
              <SettingsCard>
                <SettingsRow label="Configuration">
                  <Button label="Reload" onClick={reload} />
                </SettingsRow>
              </SettingsCard>
            </PageSection>
          ) : null}
          <PageSection title="Account">
            <SettingsCard>
              <SettingsRow
                description={user.email}
                label={user.name}
                lead={<Avatar name={user.name} />}
              />
              <SettingsRow
                description="Sign out of Golem on this device."
                label="Sign out"
              >
                <Button label="Sign out" onClick={() => signOut()} />
              </SettingsRow>
            </SettingsCard>
          </PageSection>
        </PageContent>
      </section>
    </Shell>
  );
}

/** Restarts Golem, which then reads config/golem.toml again. */
async function reload() {
  try {
    await request("/server/restart", { method: "POST" });
    showToast("success", "Golem restarts");
  } catch (error) {
    showError(error);
  }
}
