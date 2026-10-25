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

- The web app and the iOS app have the same functionality. Every feature is a web page or Datastar endpoint in
  `src/web.ts` and a JSON endpoint in `src/api.ts`, documented in `docs/api.md`, and both call the same code in
  `src/workspaces.ts`, `src/threads.ts`, or `src/llm.ts`.
- Every workspace read and write goes through a membership check in `Workspaces`; answer `404` to non-members.

## Design System

- Change colors, type, spacing, radii, sizes, and shadows only in `design/tokens.json`, then run `bun run tokens`.
  Never edit `public/tokens.css` or `ios/Golem/Design/Tokens.swift` by hand.
- A component change on one platform needs the same change on the other: `public/styles.css` and `src/ui/` for the web,
  `ios/Golem/Design/` and `ios/Golem/Views/` for iOS. Show new components on `/design` and in `DesignCatalogView`.
- `design/components.md` is the spec for every component, measured from Linear. Build controls from it: never a
  native select, picker, menu, toggle, or alert. Web behaviors live in `public/ui.js`.
- iOS controls keep 44 pt touch targets where the web uses 28 px rows.

## Code Conventions

- Use descriptive names; do not abbreviate domain concepts.
- Do not introduce `mock.module()` in tests; use dependency injection.
- Order functions top-down by call hierarchy, with entry points before their helpers.
- Use JSDoc for exported user-facing code examples.
- Every backend HTTP route declares `auth: 'required' | 'optional' | 'none'`.

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
