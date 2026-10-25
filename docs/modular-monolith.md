# Plan: modular monolith with vertical domain slices

Status: proposed. This plan changes where code lives, not what Golem does. Every step keeps all tests green and
the web and iOS behavior unchanged.

## Why

The server code is split by technical layer. One feature touches five or more files in different places:

| Layer | File | Holds |
| --- | --- | --- |
| JSON routes | `src/api.ts` | The routes of every domain |
| Web routes | `src/web.ts` | The routes of every domain, and the web helpers (`page`, `action`, `form`, toasts, assets) |
| Pages | `src/ui/pages.ts` | The pages of every domain |
| Services | `src/workspaces.ts` | Workspaces, members, channels, the thread registry, integrations, credentials, and `HttpError` |
| Schema | `src/database.ts` | One migration with the tables of every domain |

This causes these problems:

1. **A feature has no home.** To add "rename a channel", you edit `workspaces.ts`, `api.ts`, `web.ts`, `pages.ts`,
   `docs/api.md`, and a test file that tests all of the server.
2. **`workspaces.ts` does six jobs.** It is the largest service, and every new domain adds to it.
3. **Dependencies go in circles.** `threads.ts` imports `SearchResponse` from `search/indexer.ts`, and the indexer
   imports `Threads`. `createApp` connects them with a closure that refers to `indexer` before it exists.
   `llm.ts` imports `HttpError` from `workspaces.ts`.
4. **Modules read other modules' tables.** The indexer reads `organization` and `thread` with its own SQL.
   `Workspaces.thread()` joins `thread` with `member`.
5. **Tests do not follow features.** `test/server.test.ts` tests many domains in one shared server.

## Target

A module is a vertical slice of one domain: its tables, its service, its JSON routes, its web routes and pages,
and its tests. Modules talk to each other only through their entry file. A small platform holds what every
module needs and knows no domain.

```text
src/
├── main.ts                  The process: config, embedder, server, and the list of all routes
├── app.ts                   The composition root: makes each service and connects the ports
├── platform/                Shared kernel. Imports no module.
│   ├── config.ts            from src/config.ts
│   ├── secrets.ts           from src/secrets.ts
│   ├── database.ts          from src/database.ts: openDatabase, migrate, the migration list, settings
│   ├── auth.ts              from src/auth.ts: better-auth, User, currentUser
│   ├── http.ts              from src/app.ts: Route, Handler, routes(), signedIn, json, withCookies, HttpError
│   ├── web.ts               from src/web.ts: page, action, form, html, redirect, toasts, cross-origin check, assets
│   ├── api.ts               from src/api.ts: api, readBody, eventStream
│   └── ui/                  from src/ui/: components, icons, htmlDocument, the /design page
├── accounts/                Sign-in and sign-out
│   ├── web.ts               /login, /logout
│   ├── api.ts               /api/v1/sign-in/google, /api/v1/sign-in/google/done
│   └── pages.ts             authPage
├── workspaces/              The directory: workspaces, members, channels, and the thread registry
│   ├── workspaces.ts        Entry: Workspaces (membership check, members, channels, registerThread, touchThread)
│   ├── shell.ts             Entry: the app frame (sidebar with workspaces, channels, threads; dialogs)
│   ├── web.ts               /, /workspaces/new, /workspaces, /w/:workspace, channels, members
│   ├── api.ts               /api/v1/me, /api/v1/workspaces…, channels, members
│   └── pages.ts             newWorkspacePage, channelPage
├── threads/                 Conversations with the agent: one Pi Durable session per thread
│   ├── threads.ts           Entry: Threads (create, send, messages, watch), the Recall port
│   ├── web.ts               /w/:workspace/t/:thread, events, messages, new thread
│   ├── api.ts               /api/v1/threads…, new thread
│   └── pages.ts             threadPage, transcript
├── llm/                     The shared LLM provider
│   ├── llm.ts               Entry: Llm, the credential store
│   ├── web.ts               /settings/llm, login, logout, model, effort
│   ├── api.ts               /api/v1/llm…
│   └── pages.ts             llmCard
├── integrations/            Integration catalog, credentials, and per-person enablement
│   ├── integrations.ts      Entry: Integrations (list, setEnabled, addCredential, deleteCredential, usableCredentials)
│   ├── web.ts, api.ts
│   └── pages.ts             integrationsSection
├── search/                  Unchanged inside; it gets its routes and page
│   ├── indexer.ts           Entry: Indexer
│   ├── embedder.ts, extract.ts, workspace-index.ts
│   ├── web.ts, api.ts
│   └── pages.ts             from src/ui/search.ts
└── settings/                Screens that put the sections of several modules on one page
    ├── web.ts               /settings, /w/:workspace/settings
    └── pages.ts             settingsPage, workspaceSettingsPage
```

Each module keeps its tests next to its code (`src/<module>/*.test.ts`). `test/harness.ts` stays as the shared test
server.

### Dependency order

A module may import only modules to its left. There are no cycles.

```text
platform, accounts, workspaces, llm, threads, integrations, search, settings, app.ts, main.ts
```

The real edges are fewer: `threads` uses `workspaces` and `llm`; `integrations` uses `workspaces`; `search` uses
`workspaces` and `threads`; `settings` uses `workspaces`, `llm`, and `integrations`.

### Rules

1. **One owner per table.** `workspaces` owns `channel` and `thread`. `integrations` owns `credential` and
   `integration_setting`. `llm` owns `provider_credential` and its keys in `setting`. better-auth owns its tables
   through `platform/auth.ts`; only `workspaces` reads `organization` and `member`. Other modules call the owner's
   service and never query its tables.
2. **Import another module only through its entry file**: `<module>/<module>.ts`, plus `workspaces/shell.ts` for the
   app frame. A module's `web.ts`, `api.ts`, and `pages.ts` are private to it. Only `main.ts` imports route files.
   Biome's `noBarrelFile` stays on, so an entry file holds real code and does not re-export.
3. **Membership stays in one place.** Every workspace read and write calls `workspaces.get(workspaceId, user)` (to
   be renamed `requireMember`) before it does anything. Non-members get `404`.
4. **Ports for the one backward edge.** `threads` declares what it needs from search as a type it owns (`Recall`,
   with its own `RecallResult`) and a `changed` callback. `app.ts` connects them to the `Indexer`. This is the
   `ThreadHooks` interface that exists now, without the import of `SearchResponse`.
5. **Routes get services from `input.app`,** as now. No DI container, no Effect layer per module.
6. **Web and JSON stay in step.** A feature is a web route in `<module>/web.ts` and a JSON route in
   `<module>/api.ts`, both calling the module's service, documented in `docs/api.md`.

### Schema

Keep the single append-only migration list in `platform/database.ts`. A migration that shipped is history, and
`PRAGMA user_version` already orders it. Each new migration gets a comment that names its owner module. Splitting
the version counter per module would need a new bookkeeping table and an upgrade step on every machine, for no gain
at this size. Revisit only if two modules often add migrations at the same time.

### Enforcement

Add `test/architecture.test.ts` (about 30 lines, no new dependency). It reads the import statements of `src/**/*.ts`
and fails when:

- a module imports a module to its right in the dependency order,
- a module imports a file of another module other than its entry file,
- anything other than `main.ts` imports a `web.ts` or `api.ts`, or
- `platform/` imports a module.

Biome's `noRestrictedImports` cannot express "only the file named like its folder", so a test is the simplest check.

## Steps

Each step is one commit. After each step, run `bun run lint`, `bun run typecheck`, and `bun test --coverage`.
Use `git mv` so history follows the files. Do not change behavior and structure in the same step.

1. **Platform.** Move `config.ts`, `secrets.ts`, `database.ts`, `auth.ts`, and `ui/` to `platform/`. Move `HttpError`
   from `workspaces.ts`, and `Route`, `routes()`, `signedIn`, `json`, `withCookies` from `app.ts`, to
   `platform/http.ts`. Move the web helpers out of `web.ts` to `platform/web.ts` and `api()`, `readBody`,
   `eventStream` out of `api.ts` to `platform/api.ts`. Add the architecture test with only the `platform` rule.
2. **Accounts.** Move the sign-in routes and `authPage`.
3. **LLM.** Move `llm.ts`, its routes, and `llmCard` to `llm/`.
4. **Integrations.** Take the integration and credential methods out of `Workspaces` into a new `Integrations`
   service that calls `workspaces.get()` for membership. Move their routes and `integrationCard`.
5. **Threads.** Move `createThread` and `send` from `Workspaces` to `Threads`. `Workspaces` keeps the registry
   writes as `registerThread` and `touchThread`. `Threads` gets `Workspaces` in its constructor; `Workspaces` no
   longer gets `Threads`. Replace the `SearchResponse` import with the `Recall` port. Move the thread routes,
   `threadPage`, and `transcript`.
6. **Workspaces.** Move what is left of `workspaces.ts`, `shell.ts`, the workspace and channel routes, and their
   pages. Rename `get` to `requireMember`.
7. **Search.** Give `Workspaces` a `listIds()` and `Threads` (or the registry in `Workspaces`) a
   `threadsIn(workspaceId)`; replace the indexer's SQL on `organization` and `thread` with them. Move the search
   routes and `src/ui/search.ts`.
8. **Settings.** Move `/settings` and `/w/:workspace/settings` with their pages to `settings/`.
9. **Tests and rules.** Split `test/server.test.ts` and the other tests into the modules. Turn on every rule of the
   architecture test. Update `AGENTS.md` (the "Web and iOS" and "Design System" paths), `README.md`, and
   `design/components.md` to the new paths. Order `docs/api.md` by module.

Steps 2 to 4 are independent. Step 5 must come before steps 6 and 7.

## iOS (optional, after step 9)

Group `ios/Golem/Views/` into `ios/Golem/Features/<Module>/` with the same module names, and split
`APIClient.swift` into one extension per module. Then one feature change touches one folder on each platform.
`ios/Golem/Design/` stays shared, as `src/platform/ui/` does.

## Not in this plan

- No microservices, message bus, or event sourcing. One process, one `golem.sqlite`.
- No per-module DI container or Effect layers; `createApp` stays plain constructor calls.
- No change to the search internals, the data layout in `docs/data.md`, or the JSON API.
