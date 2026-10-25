import type { Route } from "../app/http.ts";
import { html, page, toastOf } from "../app/web.ts";
import { shellContext } from "../workspaces/shell.ts";
import { settingsPage, workspaceSettingsPage } from "./pages.ts";

/** The settings pages, which show sections of several modules. */
export const settingsWebRoutes: readonly Route[] = [
  [
    "GET",
    "/w/:workspace/settings",
    page(async (input) => {
      const { app, user, params } = input;
      const members = app.workspaces.members(params.workspace!, user);
      const integrations = app.integrations.list(params.workspace!, user);
      const machines = app.hands.machines(params.workspace!, user);
      const pairing = app.hands.pairing(params.workspace!, user);
      return html(
        workspaceSettingsPage(
          shellContext(input, {}),
          members,
          { machines, pairing },
          integrations
        )
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
