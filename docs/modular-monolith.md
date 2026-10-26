# Modular monolith

The server is one process with one `golem.sqlite`, split into modules. A module is a vertical slice of one domain:
its service, its tests, and its JSON routes when people use them directly. Modules talk to each other only through their
entry file. `test/architecture.test.ts` enforces the rules on this page.

## Why

The code was first split by technical layer: all JSON routes in `src/api.ts`, all web routes in `src/web.ts`, all
pages in `src/ui/pages.ts`, and six jobs in `src/workspaces.ts`. A feature touched files all over `src/`, and the
dependencies went in circles (`threads` ↔ `search`, `llm` → `workspaces`). Now a feature lives in one folder, and
the dependencies go in one direction.

## Layout

```text
src/
├── main.ts                  The process: config, embedder, server
├── app/                     Composition and route helpers
│   ├── app.ts               createApp: makes each service and connects the ports
│   ├── routes.ts            Every route table, the web app's paths, and /assets
│   ├── http.ts              Route, routes(), signedIn, json, withCookies, error responses
│   ├── web.ts               The web app's page and files, assets, html, redirect, readForm, the cross-origin check
│   └── api.ts               api, readBody, eventStream
├── platform/                Shared code that knows no domain
│   ├── config.ts, secrets.ts, database.ts, auth.ts, errors.ts, requirements.ts
├── accounts/                Sign-in and sign-out (better-auth is in platform/auth.ts)
├── workspaces/              Workspaces, members, channels, and the thread registry
├── llm/                     The shared LLM provider, its stored login, and the agents' web search
├── hands/                   The machines of each workspace: pairing, connections, and the agents' hands tools
├── integrations/            The connectors, their tools, and the credentials of workspaces and people
├── artifacts/               The pages and small apps agents make for a channel, their link pages, and their data
├── browser/                 The headless Chrome of each thread, which agents visit websites with
├── notifications/           Each person's inbox, the devices that get pushes, and the APNs sender
├── threads/                 One Pi Durable session per workspace, a conversation per thread, the agent tools, and the
│                            files of each channel
├── search/                  Extraction, embeddings, and the index of each workspace
├── routines/                Scheduled scripts and instructions of each channel, and their runs
├── reminders/               One-time workspace reminders and their agent tools; no user routes
```

Each module has the same files, when it needs them:

| File | Holds |
| --- | --- |
| `<module>.ts` | The entry file: the service class and its types |
| `api.ts` | The JSON routes for the web app and the iOS app, documented in `docs/api.md` |
| `web.ts` | Routes that serve HTML themselves; only `artifacts` has them, for its link pages |
| `pages.ts` | The HTML of those pages |
| `*.test.ts` | The tests of the module |

`search/` also has internal files: `extract.ts`, `embedder.ts`, and `workspace-index.ts`; `hands/` has
`connection.ts` and `tools.ts`; `llm/` has `search.ts` and `tools.ts`; `artifacts/`, `browser/`, and `routines/` have `tools.ts`; `notifications/` has `apns.ts`. The `hands` daemon itself, in Rust, is in the top-level `hands/` folder.

## The web app

`web/` is a React single-page app that `bun run build` bundles into `dist/web/`. It has the same modules as `src/`, in
the same order, and `settings`, which shows sections of several. Each module has `data.ts`, its collections and
queries, and its screens. `web/app/` holds the API client (`api.ts`), the types of `docs/api.md` (`types.ts`), the
Query cache that IndexedDB keeps (`query.ts`), and the routes (`router.tsx`); `web/ui/` is the design system. A
module uses only `app/`, `ui/`, and the modules before it, and never the server's code.

## Rules

1. **One direction.** The modules are in this order: `accounts`, `workspaces`, `llm`, `hands`, `integrations`,
   `artifacts`, `browser`, `notifications`, `threads`, `search`, `routines`, `reminders`. A module uses only the modules before it. `platform/` uses no module.
2. **Entry files only.** A service uses another module only through its `<module>.ts`. Routes and pages can also
   use another module's `pages.ts`. Only `app/routes.ts` imports `web.ts` and `api.ts`.
   Biome's `noBarrelFile` stays on, so an entry file holds real code and does not re-export.
3. **Services do not know HTTP routes.** A service throws `HttpError` from `platform/errors.ts` for bad input or
   missing access, and never imports from `app/`. `app/app.ts` makes the services; routes get them from `input.app`.
4. **One owner per table.** Only the owner module queries a table (see the comment in `platform/database.ts`). The
   indexer reads workspaces and threads through `Workspaces.ids` and `Workspaces.threadsIn`.
5. **Membership in one place.** Every workspace read and write calls `Workspaces.requireMember` first. Non-members
   get `404`.
6. **Ports for the backward edges.** `threads` needs search for its recall tool, and search reads threads. So
   `threads` declares the port it needs (`ThreadHooks.recall`, with its own `RecallResult` type), and
   `app/app.ts` connects it to the indexer. In the same way, `ThreadHooks.tools` gives agents the tools of
   `routines`, which runs its work in threads.

## Schema

The migration list in `platform/database.ts` stays one append-only list: `PRAGMA user_version` orders it, and a
migration that shipped is history. Each new migration starts with a comment that names its owner module. A version
per module would need a bookkeeping table and an upgrade step on every machine, for no gain at this size.

## Tests

- Module tests are next to their code, for example `src/search/indexer.test.ts`.
- `test/` holds the end-to-end tests that drive the whole server as a person would (`server`, `api`, and `web`),
  the shared test server in `test/harness.ts`, the design token check, the architecture test, and the check that the
  web app's API types fit the server's (`web-types`).
- Web tests are next to their code too, for example `web/threads/message.test.tsx`.

## Add a feature

1. Put the logic in the module's service, with a membership check if it reads or writes a workspace.
2. Add the JSON route to `api.ts`, and the screen to the module's folder in `web/`: its data in `data.ts`, as a
   TanStack DB collection when people change it, and its components next to it.
3. Document the JSON route in `docs/api.md`, and add the same screen to the iOS app.
4. A new module needs a place in the module order in `test/architecture.test.ts` and in `AGENTS.md`, its route
   tables in `app/routes.ts`, and its service in `createApp`.

## Not done

- iOS still groups its code by kind (`ios/Golem/Views/`, `ios/Golem/API/`). Grouping it by the same modules is
  possible later; `ios/Golem/Design/` would stay shared, as `web/ui/` does.
- No microservices, message bus, DI container, or Effect layer per module.
