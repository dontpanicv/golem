import { api } from "../app/api.ts";
import { json, type Route } from "../app/http.ts";

/** The shared LLM provider. */
export const llmApiRoutes: readonly Route[] = [
  [
    "GET",
    "/api/v1/llm",
    api(async ({ app, user }) => json(await app.llm.status(user))),
  ],
  [
    "POST",
    "/api/v1/llm/login",
    api(async ({ app, user }) => json(await app.llm.startLogin(user))),
  ],
  [
    "POST",
    "/api/v1/llm/logout",
    api(async ({ app, user }) => json(await app.llm.logout(user))),
  ],
  [
    "PUT",
    "/api/v1/llm/model",
    api(async ({ app, user, body }) => {
      app.llm.setModel(user, body.model as string);
      return json(await app.llm.status(user));
    }),
  ],
  [
    "PUT",
    "/api/v1/llm/effort",
    api(async ({ app, user, body }) => {
      app.llm.setEffort(user, body.effort as string);
      return json(await app.llm.status(user));
    }),
  ],
  [
    "GET",
    "/api/v1/workspaces/:workspace/usage",
    api(async ({ app, user, params, request }) => {
      const workspace = app.workspaces.requireMember(params.workspace!, user);
      const days = Number(new URL(request.url).searchParams.get("days"));
      const report = app.llm.usage(workspace.id, user, days);
      // Titles only of the threads the person sees; the owner's totals still count the others.
      const titles = new Map(
        app.workspaces
          .threadsIn(workspace.id, user.id)
          .filter(
            (thread) => thread.ownerId === null || thread.ownerId === user.id
          )
          .map((thread) => [thread.id, thread.title])
      );
      const names = new Map(
        app.workspaces
          .members(workspace.id, user)
          .map((member) => [member.userId, member.name])
      );
      return json({
        ...report,
        threads: report.threads.flatMap((row) =>
          titles.has(row.threadId)
            ? [{ ...row, title: titles.get(row.threadId)! }]
            : []
        ),
        people:
          report.people?.map((row) => ({
            ...row,
            name: row.userId
              ? (names.get(row.userId) ?? "Former member")
              : "Golem",
          })) ?? null,
      });
    }),
  ],
];
