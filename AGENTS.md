# Golem Agent Guidance

Golem is a family AI assistant and second brain that runs on our own machines, with no cloud and no central server.

## General Rules

- Always talk in ASD-STE100 Simplified Technical English.
- Remove obsolete application paths; do not add compatibility layers, fallbacks, or migrations for them. Database
  migrations must use expand-and-contract so a machine on the previous version keeps working while the others
  upgrade. Remove obsolete schema only after no machine runs a version that uses it.
- Use the simplest complete implementation. Avoid speculative abstractions, configuration, and indirection. Start
  with a working end-to-end product, then add capabilities in layers. Never replace working behavior with unfinished
  complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, maintained libraries that reduce complexity or improve reliability. Reimplement common
  functionality only with a clear reason.
- Use existing dependencies first; check their documentation and types before writing code or adding packages.
- Make long-term architectural decisions; do not add stopgaps meant for later replacement.
- Make the best decision that will elevate all three: the user experience (UX), developer experience (DX), and agent
  experience (AX) always, without breaking anything.
- Cut taglines, helper text, and secondary labels. If a screen needs them to make sense, fix the layout.

## Public Repository

This repository is public. Never commit secrets, tokens, personal or family data, private hostnames or VPN
addresses, or code and data from employers or clients.

## Working Rules

- Use Bun, not npm or Yarn.
- Inspect relevant existing patterns when the implementation is unfamiliar; match their structure and primitives.
- Add guidance only for stable, non-obvious conventions not enforced or documented elsewhere.

## Web and iOS

- The web app and the iOS app have the same functionality. Every feature is a JSON endpoint in `src/<module>/api.ts`,
  documented in `docs/api.md`, that calls the module's service in `src/<module>/<module>.ts`; both apps use it. The web
  app is a React single-page app in `web/`; the server sends it for every app path and has no other pages.
- Reminders are agent-only: their create, list, change, and cancel operations are tools, with no user routes.
- Every workspace read and write goes through `Workspaces.requireMember`; answer `404` to non-members.
- Serve HTML that an agent or a person wrote only from `/a/:id/content`, with its `sandbox` content policy; never run
  it on Golem's origin.

## Web app

- Data that changes keeps its rows in a TanStack DB collection (`web/<module>/data.ts`), whose `onInsert`, `onUpdate`,
  and `onDelete` call the API, so a change shows at once and rolls back if the server refuses it. Other data uses
  TanStack Query. The Query cache is saved in IndexedDB, so the app opens on what it showed last.
- The event streams of `docs/api.md` keep open threads and the working threads current; do not poll what they send.
- Text messages go through the outbox (`web/threads/outbox.ts`), which keeps them in localStorage and sends them with a
  `requestId` once Golem answers; a message with files needs a connection.
- The saved cache and the outbox belong to one person (`confirmPerson` in `web/app/query.ts`): after a `401` or the
  start of a sign-in they wait; the same person gets both back, and the browser forgets both for another person.
- The app page has a content policy (`src/app/web.ts`): scripts, pictures, and frames come only from Golem. A
  picture from the web in Markdown shows as a link.
- `bun start` builds the app into `dist/web/` first; `bun run dev` rebuilds it on every change.

## Modules

- `src/` is a modular monolith. A module (`accounts`, `workspaces`, `llm`, `hands`, `integrations`, `artifacts`,
  `browser`, `notifications`, `threads`, `search`, `routines`, `reminders`) holds one domain: its service, routes, and tests. `src/platform/`
  is shared code that knows no domain; `src/app/` composes the services and holds the route helpers.
- A module uses only the modules before it in that list, through their `<module>.ts` file, or their `pages.ts` from
  routes. A module reads only the tables it owns. `test/architecture.test.ts` enforces these rules;
  `docs/modular-monolith.md` explains them.
- `web/` has the same modules, and `settings`; each uses only `web/app/`, `web/ui/`, and the modules before it. It never
  imports from `src/`: `web/app/types.ts` holds the types of `docs/api.md`, and `test/web-types.test.ts` checks them
  against the server's.
- Register new route tables in `src/app/routes.ts` and new services in `createApp` in `src/app/app.ts`.
- Every integration works in both places, with one connector and no code for either place: a person connects it in
  Workspace settings for every member's turns there, or in their own Settings for their own turns in each of their
  workspaces. A tool call uses the credential of its turn's person first, else the workspace's
  (`src/integrations/integrations.ts`). A person can connect several accounts of one integration; each tool takes an
  `account`.
- Agents only draft mail and messages as a person: a connector never gives them a tool that sends, and hides such
  tools of an MCP server with `hiddenTools`.
- The model calls only the core tools of channels, threads, files, and web search directly. Every other tool is
  script-only (`callers: ["tools"]`) and its name starts with its codemode namespace: `NAMESPACES` in
  `src/threads/threads.ts`, or `<integration>_` for a connector, whose MCP server gives its tools.
- In `src/threads/threads.ts`, a tool that runs a shell command on a machine is in `RUNS_COMMAND`, so `approved` asks a
  person before a command that dcg (destructive_command_guard) flags; nothing else waits for one. All web traffic of agents
  goes through `Egress` (`src/platform/egress.ts`), never a plain `fetch`.

## Design System

- Change colors, type, spacing, radii, sizes, and shadows only in `design/tokens.json`, then run `bun run tokens`.
  Never edit `public/tokens.css` or `ios/Golem/Design/Tokens.swift` by hand.
- A component change on one platform needs the same change in function on the other: `public/styles.css` and
  `web/ui/` for the web, `ios/Golem/Design/` and `ios/Golem/Views/` for iOS. Each platform keeps the look of
  Linear's app on it.
- `design/components.md` is the spec for every component, measured from Linear's web and iOS apps. The web never uses a
  native select, picker, menu, toggle, or alert; menus, selects, and tooltips are Radix primitives in `web/ui/`. iOS keeps the look of Linear's iOS app
  (native menus, the system glass, and the `mobile` tokens) in the navigation of Slack's iOS app.
- iOS controls keep 44 pt touch targets where the web uses 28 px rows.

## Code Conventions

- Use descriptive names; do not abbreviate domain concepts.
- Do not introduce `mock.module()` in tests; use dependency injection.
- Order functions top-down by call hierarchy, with entry points before their helpers.
- Use JSDoc for exported user-facing code examples.
- Every backend HTTP route declares `auth: 'required' | 'optional' | 'none'`.
- Deletes are soft; nothing is ever removed. Set `deleted_at` and leave such rows out of every read; move a deleted
  file aside. A unique name gets `~<id>` when deleted, so the name is free again. `docs/data.md` has the rules.

## Verification

Run the smallest relevant check while developing and the full test sweep once before handoff.

## Shortcuts

- `agent-learn` / `al`: add only stable, reusable, non-discoverable guidance; otherwise change nothing.
- `agent-check` / `ac`: run lint, typecheck, and relevant tests; fix and re-run failures.
- `agent-commit` / `acm`: run `al`, `ac`, and the full test sweep, then commit only intended files using a Conventional
  Commit with any known ticket; do not add AI attribution.
- `agent-plan` / `ap`: inspect the affected code and write a detailed implementation plan; ask one question only if
  the target is unclear.
- `agent-review` / `ar`: review the branch diff for correctness, security, performance, architecture, and docs.

## Repository Invariants

Every directory containing `AGENTS.md` must contain a sibling `CLAUDE.md` relative symlink to it. `AGENTS.md` is the
source of truth.
