# Modular monolith

The server is one process with one `golem.sqlite`, split into modules. A module is a vertical slice of one domain:
its service, its tests, and its routes and pages when people use them directly. Modules talk to each other only through their
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
│   ├── routes.ts            Every route table, plus /assets
│   ├── http.ts              Route, routes(), signedIn, json, withCookies, error responses
│   ├── web.ts               page, action, form, html, redirect, toasts, the cross-origin check, assets
│   └── api.ts               api, readBody, eventStream
├── platform/                Shared code that knows no domain
│   ├── config.ts, secrets.ts, database.ts, auth.ts, errors.ts, requirements.ts
│   └── ui/                  The design system: components and icons
├── accounts/                Sign-in and sign-out (better-auth is in platform/auth.ts)
├── workspaces/              Workspaces, members, channels, the thread registry, and the app shell
├── llm/                     The shared LLM provider, its stored login, and the agents' web search
├── hands/                   The machines of each workspace: pairing, connections, and the agents' hands tools
├── integrations/            The connectors, their tools, and the credentials of each workspace
├── artifacts/               The pages and small apps agents make for a channel, their links, and the data they keep
├── browser/                 The headless Chrome of each thread, which agents visit websites with
├── threads/                 One Pi Durable session per workspace, a conversation per thread, the agent tools, and the
│                            channel page with the files of each channel
├── search/                  Extraction, embeddings, the index of each workspace, and the search page
├── routines/                Scheduled scripts and instructions of each channel, their runs, and the channel details page
├── reminders/               One-time workspace reminders and their agent tools; no user routes
└── settings/                The settings pages, which show sections of several modules
```

Each module has the same files, when it needs them:

| File | Holds |
| --- | --- |
| `<module>.ts` | The entry file: the service class and its types |
| `api.ts` | The JSON routes for the iOS app, documented in `docs/api.md` |
| `web.ts` | The web routes: pages and Datastar endpoints |
| `pages.ts` | The HTML of the module's pages and the sections other modules show |
| `*.test.ts` | The tests of the module |

`workspaces/shell.ts` is the app frame (sidebar, workspace switcher, dialogs) that every signed-in page uses.
`search/` also has internal files: `extract.ts`, `embedder.ts`, and `workspace-index.ts`; `hands/` has
`connection.ts` and `tools.ts`; `llm/` has `search.ts` and `tools.ts`; `artifacts/`, `browser/`, and `routines/` have `tools.ts`. The `hands` daemon itself, in Rust, is in the top-level `hands/` folder.

## Rules

1. **One direction.** The modules are in this order: `accounts`, `workspaces`, `llm`, `hands`, `integrations`,
   `artifacts`, `browser`, `threads`, `search`, `routines`, `reminders`, `settings`. A module uses only the modules before it. `platform/` uses no module.
2. **Entry files only.** A service uses another module only through its `<module>.ts`. Routes and pages can also
   use another module's `pages.ts` and `workspaces/shell.ts`. Only `app/routes.ts` imports `web.ts` and `api.ts`.
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
  the shared test server in `test/harness.ts`, the design token check, and the architecture test.

## Add a feature

1. Put the logic in the module's service, with a membership check if it reads or writes a workspace.
2. Add the JSON route to `api.ts` and the web route to `web.ts`, and the HTML to `pages.ts`.
3. Document the JSON route in `docs/api.md`, and add the same screen to the iOS app.
4. A new module needs a place in the module order in `test/architecture.test.ts` and in `AGENTS.md`, its route
   tables in `app/routes.ts`, and its service in `createApp`.

## Not done

- iOS still groups its code by kind (`ios/Golem/Views/`, `ios/Golem/API/`). Grouping it by the same modules is
  possible later; `ios/Golem/Design/` would stay shared, as `src/platform/ui/` does.
- No microservices, message bus, DI container, or Effect layer per module.
