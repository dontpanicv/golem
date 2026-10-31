import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { LoginPage } from "../accounts/login.tsx";
import { SuggestionCards, UpcomingPage } from "../agenda/page.tsx";
import { InboxPage } from "../notifications/page.tsx";
import { ChannelDetails } from "../routines/details.tsx";
import { SearchPage } from "../search/page.tsx";
import { SettingsPage, WorkspaceSettingsPage } from "../settings/pages.tsx";
import { ChannelPage, ThreadPage } from "../threads/pages.tsx";
import { TooltipProvider } from "../ui/components.tsx";
import { FilePreview } from "../ui/file-preview.tsx";
import { Toasts } from "../ui/toast.tsx";
import { Home, OrchestratorPage, WorkspaceHome } from "../workspaces/pages.tsx";
import { SignedIn, WorkspaceLayout } from "../workspaces/shell.tsx";

/** A search parameter that is text, or nothing. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `?artifact=` opens an artifact in the side panel. */
const withArtifact = (
  search: Record<string, unknown>
): { artifact?: string } => ({
  artifact: text(search.artifact),
});

const root = createRootRoute({
  component: () => (
    <TooltipProvider>
      <Outlet />
      <FilePreview />
      <Toasts />
    </TooltipProvider>
  ),
});

const login = createRoute({
  getParentRoute: () => root,
  path: "/login",
  // A failed Google sign-in comes back with `error` and `error_description`.
  validateSearch: (search): { next?: string; error?: string } => ({
    next: text(search.next),
    error: text(search.error_description) ?? text(search.error),
  }),
  component: LoginPage,
});

const signedIn = createRoute({
  getParentRoute: () => root,
  id: "signed-in",
  component: SignedIn,
});

const home = createRoute({
  getParentRoute: () => signedIn,
  path: "/",
  component: Home,
});

const settings = createRoute({
  getParentRoute: () => signedIn,
  path: "/settings",
  component: SettingsPage,
});

const workspace = createRoute({
  getParentRoute: () => signedIn,
  path: "/w/$workspaceId",
  component: WorkspaceLayout,
});

const workspaceHome = createRoute({
  getParentRoute: () => workspace,
  path: "/",
  component: WorkspaceHome,
});

const orchestrator = createRoute({
  getParentRoute: () => workspace,
  path: "/orchestrator",
  validateSearch: withArtifact,
  component: OrchestratorPage,
});

const channel = createRoute({
  getParentRoute: () => workspace,
  path: "/c/$channelId",
  validateSearch: withArtifact,
  // The channel's details come from the routines module, which comes after threads.
  component: () => <ChannelPage details={<ChannelDetails />} />,
});

const thread = createRoute({
  getParentRoute: () => workspace,
  path: "/t/$threadId",
  validateSearch: withArtifact,
  // The suggestions over the orchestrator's composer come from the agenda module, which comes after threads.
  component: () => <ThreadPage orchestratorCards={<SuggestionCards />} />,
});

const inbox = createRoute({
  getParentRoute: () => workspace,
  path: "/inbox",
  component: InboxPage,
});

const upcoming = createRoute({
  getParentRoute: () => workspace,
  path: "/upcoming",
  component: UpcomingPage,
});

const searchRoute = createRoute({
  getParentRoute: () => workspace,
  path: "/search",
  validateSearch: (values): { q?: string } => ({ q: text(values.q) }),
  component: SearchPage,
});

const workspaceSettings = createRoute({
  getParentRoute: () => workspace,
  path: "/settings",
  component: WorkspaceSettingsPage,
});

export const router = createRouter({
  routeTree: root.addChildren([
    login,
    signedIn.addChildren([
      home,
      settings,
      workspace.addChildren([
        workspaceHome,
        orchestrator,
        channel,
        thread,
        inbox,
        upcoming,
        searchRoute,
        workspaceSettings,
      ]),
    ]),
  ]),
  defaultPreload: "intent",
  defaultNotFoundComponent: () => (
    <div className="empty">
      <strong>Not found</strong>
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
