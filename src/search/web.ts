import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import type { Route } from "../app/http.ts";
import { html, page } from "../app/web.ts";
import { shellContext } from "../workspaces/shell.ts";
import { searchPage, searchResults } from "./pages.ts";

/** The search page, and its results as you type. */
export const searchWebRoutes: readonly Route[] = [
  [
    "GET",
    "/w/:workspace/search",
    page(async (input) => {
      const context = shellContext(input, {});
      const query = new URL(input.request.url).searchParams.get("q") ?? "";
      const response = query.trim()
        ? await input.app.indexer.search(context.workspace!.id, query)
        : null;
      return html(searchPage(context, query, response));
    }),
  ],
  [
    "GET",
    "/w/:workspace/search/results",
    page(async (input) => {
      const workspace = input.app.workspaces.requireMember(
        input.params.workspace!,
        input.user
      );
      const signals = await ServerSentEventGenerator.readSignals(input.request);
      const query =
        signals.success && typeof signals.signals.q === "string"
          ? signals.signals.q
          : "";
      const response = query.trim()
        ? await input.app.indexer.search(workspace.id, query)
        : null;
      const results = searchResults(
        workspace.id,
        query,
        response,
        input.app.workspaces.channels(workspace.id, input.user)
      );
      return ServerSentEventGenerator.stream((stream) => {
        stream.patchElements(results);
      });
    }),
  ],
];
