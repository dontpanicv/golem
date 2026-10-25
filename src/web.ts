import type { Route } from "./app/http.ts";
import { asset, html, page, toastOf } from "./app/web.ts";
import { designPage } from "./platform/ui/design.ts";
import { settingsPage, workspaceSettingsPage } from "./ui/pages.ts";
import { shellContext } from "./workspaces/shell.ts";

/** The web app: HTML from the server, live parts over Datastar. */
export const webRoutes: readonly Route[] = [
  ["GET", "/assets/*", async ({ request }) => asset(request)],
  ["GET", "/design", async () => html(designPage())],

  [
    "GET",
    "/w/:workspace/settings",
    page(async (input) => {
      const { app, user, params } = input;
      const members = app.workspaces.members(params.workspace!, user);
      const integrations = app.integrations.list(params.workspace!, user);
      return html(
        workspaceSettingsPage(shellContext(input, {}), members, integrations)
      );
    }),
  ],
  [
    "GET",
    "/settings",
    page(async ({ app, user, request }) => {
      // Keep the first workspace in the sidebar, so settings feel like part of the app.
      const workspaces = app.workspaces.list(user);
      const [workspace] = workspaces;
      const channels = workspace
        ? app.workspaces.channels(workspace.id, user)
        : undefined;
      return html(
        settingsPage(
          { user, workspaces, workspace, channels, toast: toastOf(request) },
          await app.llm.status()
        )
      );
    }),
  ],
];
