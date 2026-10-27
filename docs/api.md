# Golem API

The web app and the iOS app have the same functionality, and both use this JSON API. The iOS app sends a bearer token;
the web app sends its session cookie, and a request that names another origin than `base_url` gets `403`.

## Authentication

Accounts are managed by [better-auth](https://www.better-auth.com). People sign in only with Google, and only with
an email in `allowed_emails` in `config/golem.toml`. There is no sign-up and no password. Native clients use bearer
tokens; the web app uses better-auth's session cookie. The routes are in `src/accounts/`.

| Request | Response |
| --- | --- |
| `GET /api/v1/sign-in/google` | Redirect to Google. Open it in a web authentication session that waits for the `golem` scheme. |
| `GET /api/v1/sign-in/google/done` | Redirect to `golem://signed-in?token=<token>`, or `golem://signed-in?error=<message>` |
| `POST /api/auth/sign-in/social` | `{ provider: "google", callbackURL }` → `{ url }`: the web app opens `url`, and Google sends the person back to `callbackURL` with a session cookie. A failed sign-in comes back to `/login?error=…&error_description=…`. |
| `POST /api/auth/sign-out` | `{ success }` |

`done` hands over a token only to a sign-in that `GET /api/v1/sign-in/google` started in the same browser session,
and Google always asks which account to use. This keeps another app that claims `golem://` from getting a token.

Send `Authorization: Bearer <token>`, or the session cookie, on every `/api/v1` request. A `401` response means the
token or the session is missing or expired.

## Types

```ts
type User = { id: string; name: string; email: string };
type Workspace = { id: string; name: string; role: "owner" | "member" }; // `role` is the person's
type ThreadSummary = { id: string; channelId: string; title: string; updatedAt: number; settledAt: number | null }; // times are Unix milliseconds
type Channel = {
	id: string;
	name: string;
	summary: string | null; // what the channel is for and what goes on in it, as the model last wrote it with the brief
	threads: ThreadSummary[]; // newest first
};
type Notification = {
	id: string;
	workspaceId: string;
	channelId: string;
	threadId: string | null; // null: it opens the channel
	title: string; // the thread's title
	text: string; // plain text
	createdAt: number;
	readAt: number | null;
};
type Inbox = {
	notifications: Notification[]; // the 100 newest, newest first
	unread: number; // in this workspace
	badge: number; // unread in all the person's workspaces, for the app icon
};
type Brief = {
	text: string; // Markdown with thread links, [title](thread:<threadId>)
	updatedAt: number;
};
type Message = {
	id: string;
	authorId: string | null; // null for the agent
	author: string; // display name, "Golem" for the agent
	agent: boolean;
	text: string; // may hold thread links, [title](thread:<threadId>): show each as a link that opens the thread
	time: number;
	failed: boolean; // the agent's answer failed; text is the error
	streaming: boolean; // the agent is still writing this message
	files: FileRef[]; // attached to the message; text may be empty when files are attached
	work: Work | null; // what the agent did before this answer; null for people and for an answer without work
};
// The agent's work after a message is one answer: its last words are the text, and what came before is the work.
type Work = {
	startedAt: number;
	endedAt: number | null; // null while the agent works
	stopped: boolean; // someone stopped the agent before it answered
	steps: Step[];
};
type Step = {
	kind: "thinking" | "text" | "tool"; // a thought, words between tool calls, or a tool call
	text: string; // for a tool call, the thread link in its result, or else the values of its arguments on one line
	tool: string | null; // the tool's name, such as "web_search"
	input: string | null; // a tool call's arguments as JSON, cut at 1000 characters
	output: string | null; // the start of a tool call's result, cut at 1000 characters; null until it has one
	running: boolean;
	failed: boolean;
};
type FileRef = { id: string; name: string };
type SavedFile = { id: string; name: string; size: number; time: number }; // size in bytes; ids are UUIDv7
type ThreadState = { thread: ThreadSummary; messages: Message[]; running: boolean };
type SearchResult = {
	uri: string; // thread:<id>, artifact:<id>, or a path under the workspace folder, such as channels/<id>/files/<file id>-<name>
	kind: "thread" | "artifact" | "note" | "file" | "capture";
	title: string;
	threadId: string | null;
	channelId: string | null;
	snippet: string;
	score: number;
	updatedAt: number;
};
type Member = { userId: string; name: string; email: string; role: "owner" | "admin" | "member" };
type Credential = { id: string; label: string; ownerName: string; createdAt: number };
type Integration = { id: string; name: string; connect: "secret" | "sign-in" | "phone"; secretLabel: string | null; credentials: Credential[] }; // secretLabel: for "secret"
type RoutineRun = {
	id: string;
	routineId: string;
	routineName: string;
	startedAt: number;
	finishedAt: number | null;
	outcome: "running" | "quiet" | "posted" | "failed"; // quiet: nothing needed anyone's attention
	error: string | null;
};
type Routine = {
	id: string;
	channelId: string;
	name: string;
	schedule: string; // a cron expression in the server's time zone
	instructions: string;
	script: string | null; // code mode JavaScript that collects what is new before the agent sees it
	enabled: boolean;
	nextRunAt: number | null; // null while paused
	threadId: string | null; // where its agent answers; set at the first run that reaches the agent
	lastRun: RoutineRun | null;
};
type Artifact = {
	id: string; // two words, such as "amber-fox"; a name is never given out again
	channelId: string | null; // the channel it belongs to; null: the workspace's own, which the orchestrator makes
	threadId: string; // the thread that made it
	title: string;
	visibility: "public" | "members"; // public: anyone with the link; members: signed-in members only
	url: string; // the link people share: <share_url>/<id> when public and share_url is set, else <base_url>/a/<id>
	visitors: number; // how many people opened it
	createdAt: number;
	updatedAt: number;
};
type ArtifactRecord = {
	id: string; // names the record in the route that deletes it
	visitor: string | null; // null for a shared record
	name: string | null; // the visitor's name, if they gave one
	key: string;
	value: unknown; // JSON
	updatedAt: number;
};
type Machine = {
	id: string;
	name: string; // what agents and people call it, unique in the workspace
	hostname: string | null;
	addresses: string[];
	port: number;
	certSha256: string; // the hands listener's certificate, which Golem pins
	os: string; // "macos" or "linux"
	arch: string;
	version: string; // hands version when it paired
	pairedAt: number;
};
type Pairing = { command: string; expiresAt: number }; // run `command` on the machine before `expiresAt`
type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Llm = {
	connected: boolean;
	provider: string; // "ChatGPT"
	model: string; // a model id
	effort: Effort; // the chosen effort, moved to the nearest level the model supports
	models: { id: string; name: string; efforts: Effort[] }[]; // from the provider's model catalog
	login: { userCode: string; verificationUri: string; expiresAt: number } | null; // set while a device login waits
	error: string | null; // the last login error
};
```

## Endpoints

Workspace paths answer `404` to users who are not members of the workspace.

Every delete is soft: Golem keeps what was deleted, hidden, and no route, page, tool, or search shows it again.

### Workspaces (`src/workspaces/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/me` | | `{ user: User, workspaces: Workspace[] }` |
| `POST /api/v1/workspaces` | `{ name }` | `Workspace`; the creator becomes owner, and the workspace gets a `general` channel |
| `GET /api/v1/workspaces/:workspaceId` | | `{ workspace: Workspace, channels: Channel[] }` |
| `PUT /api/v1/workspaces/:workspaceId` | `{ name }` | `Workspace`; `403` for a member who is not an owner |
| `DELETE /api/v1/workspaces/:workspaceId` | | `204`; its channels, threads, files, artifacts, and routines go with it; `403` for a member who is not an owner |
| `POST /api/v1/workspaces/:workspaceId/channels` | `{ name }` | `Channel`; `409` if the name exists |
| `DELETE /api/v1/workspaces/:workspaceId/channels/:channelId` | | `204`; its threads, files, artifacts, and routines go with it, and the orchestrator moves to the next channel; `409` for the last channel |
| `GET /api/v1/workspaces/:workspaceId/members` | | `Member[]` |
| `POST /api/v1/workspaces/:workspaceId/members` | `{ email }` | `Member`; the person must have signed in once |

### Threads (`src/threads/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/orchestrator` | | `ThreadSummary` of the workspace's orchestrator; the first call makes it |
| `POST /api/v1/workspaces/:workspaceId/threads` | `{ channelId, text }` | `ThreadSummary`; `text` becomes the first message and the title |
| `GET /api/v1/threads/:threadId` | | `ThreadState` |
| `POST /api/v1/workspaces/:workspaceId/threads/:threadId/settled` | `{ settled: boolean }` | `ThreadSummary`; settled threads stay available in their channel; `400` for the orchestrator |
| `GET /api/v1/threads/:threadId/events` | | Server-sent events: `event: thread`, `data: ThreadState` after every change |
| `POST /api/v1/threads/:threadId/messages` | `{ text, voice?, requestId? }` | `204`; a retry with the same `requestId` sends nothing again |
| `POST /api/v1/threads/:threadId/stop` | | `204`; the agent drops the messages it has not read yet and ends its run. Threads it asked for something, and that still work on that message, stop too |
| `GET /api/v1/workspaces/:workspaceId/working` | | Server-sent events: `event: working`, `data: { threadIds: string[] }`, the threads whose agent works, at once and after every change. Load the workspace again when it changes: agents start threads and channels as they work |
| `GET /api/v1/workspaces/:workspaceId/channels/:channelId/brief` | | `{ brief: Brief \| null }`: what the channel is for, where it is now, its decisions, its open questions, and what each person wants; `null` before the first |
| `GET /api/v1/workspaces/:workspaceId/channels/:channelId/files` | | `{ files: SavedFile[] }`, oldest first |
| `POST /api/v1/workspaces/:workspaceId/channels/:channelId/files` | multipart `files` | `{ files: SavedFile[] }`: all files of the channel |
| `GET /api/v1/workspaces/:workspaceId/files` | | `{ files: SavedFile[] }`: the workspace's own files, which the orchestrator keeps, oldest first |
| `POST /api/v1/workspaces/:workspaceId/files` | multipart `files` | `{ files: SavedFile[] }`: all of the workspace's own files |
| `GET /api/v1/workspaces/:workspaceId/files/:fileId` | | Any file of the workspace, in a channel or its own. Pictures, PDFs, plain text, audio, and video are `inline`; other kinds are `attachment` and `application/octet-stream`. |
| `DELETE /api/v1/workspaces/:workspaceId/files/:fileId` | | `{ files: SavedFile[] }`: the files left where it was. Messages keep the name of a deleted file. |

Files belong to a channel: every thread of the channel sees them, also after a thread is settled. The orchestrator
belongs to no channel, so its files are the workspace's own. To attach files to a new thread or a message, send the
same fields as a `multipart/form-data` form with one `files` part per file instead of JSON; the files go to the
thread's channel, or the workspace for the orchestrator. A message then needs text, files, or both; a thread without
text takes the name of its first file. A message's `FileRef` opens at `/api/v1/workspaces/:workspaceId/files/:fileId`.
The agents see each attached file by name and id; `list_files` lists the files of their channel, and `read_file` reads
any file of the workspace by its id.

The orchestrator is the one thread of a workspace that never ends: the workspace opens on it, and its agent gives
work to the threads of the channels. It is in the first channel, but no `Channel.threads` list shows it, and it cannot
be settled. Its agent remembers every message of every thread of the workspace: see `src/threads/memory.ts`.

Each channel has a brief, which the model writes again from the new messages of the channel's threads when they are
quiet for 10 minutes or settled, and the channel's summary with it. Every thread of the channel reads the brief and the
list of the channel's threads before each answer: see `src/threads/brief.ts`.

The web app keeps a text message that it cannot send yet, such as without a connection, and sends it later with a
`requestId`, so a message that reached Golem before its response was lost stays one message.

`voice: true` marks a message spoken in a conversation on the iPhone: the agent writes its answer to be read aloud, and
the message steers a run at work instead of waiting for it to end.

### Notifications (`src/notifications/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/notifications` | | `Inbox` |
| `POST /api/v1/workspaces/:workspaceId/notifications/read` | `{ id? }` | `Inbox`; marks one notification read, or all of them without `id` |
| `POST /api/v1/devices` | `{ token, environment: "sandbox" \| "production" }` | `204`; the device gets the person's pushes, and no more of another person's |
| `DELETE /api/v1/devices/:token` | | `204`; the device gets no more of the person's pushes |

A notification goes to a person's inbox when the agent answers their message, when a channel thread reports back to
a thread they write in, for each answer of a routine (to every member) or a reminder (to its recipient) that is not
`QUIET`, and when an agent calls its `notify` tool. While a screen of the person follows the thread's events stream,
its notifications are read at once and send no push; opening the stream reads the thread's notifications. Others go
to the person's devices through APNs, with the `Inbox.badge` and `workspaceId`, `channelId`, and `threadId` to open.
Close the events stream when the screen goes to the background. Pushes need `[apns]` in `config/golem.toml` and the
key in `config/apns.p8`.

### Artifacts (`src/artifacts/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/channels/:channelId/artifacts` | | `{ artifacts: Artifact[] }`, newest first, from every thread of the channel |
| `GET /api/v1/workspaces/:workspaceId/artifacts` | | `{ artifacts: Artifact[] }`: the workspace's own, which the orchestrator makes, newest first |
| `GET /api/v1/artifacts/:artifactId` | | `{ artifact: Artifact, records: ArtifactRecord[], content: string }` |
| `PUT /api/v1/artifacts/:artifactId` | `{ visibility }` | `Artifact` |
| `DELETE /api/v1/artifacts/:artifactId` | | `204`; its data goes with it |
| `POST /api/v1/artifacts/:artifactId/rpc` | `{ op, args }` | `{ result }`: a call of the artifact's `golem` runtime, as the signed-in user |
| `DELETE /api/v1/artifacts/:artifactId/data` | | `204`; every record and visitor goes |
| `DELETE /api/v1/artifacts/:artifactId/records/:recordId` | | `204` |

An artifact is a page or a small app that an agent makes in a thread with its `artifacts_create`, `artifacts_update`,
`artifacts_edit`, `artifacts_read`, `artifacts_list`, `artifacts_data`, and `artifacts_set_data` tools. It belongs to the
thread's channel, or to a channel the agent names: every thread of the channel sees it, and it stays after the thread
is settled. The orchestrator's belong to the workspace. `content` is the
agent's HTML with Golem's `golem` runtime at the top of its head. The runtime sends each call as a message: to
`window.webkit.messageHandlers.golem` in a web view, or else to the parent window. Its reply goes back through
`window.__golemReceive({ golem: 1, id, result })`, or `{ golem: 1, id, error }`. The iOS app loads `content` with no
base URL, and answers each message with `rpc`.

The runtime the page calls:

| Call | `op` and `args` | Who |
| --- | --- | --- |
| `golem.ready`, `golem.me` | `me`: `{}` → `{ id, name, member }` | everyone |
| `golem.setName(name)` | `name`: `{ name }` → the new `me` | everyone |
| `golem.mine.get/set/delete/list` | `get`, `set`, `delete`, `list`: `{ scope: "mine", key, value?, prefix? }` | everyone, on their own records |
| `golem.everyone.list(prefix?)` | `list`: `{ scope: "everyone", prefix }` → `ArtifactRecord[]` of visitors | everyone |
| `golem.shared.get/set/delete/list` | the same with `scope: "shared"` | everyone reads; members change |

`list` gives `{ key, value, updatedAt }[]` for `mine` and `shared`. A value is up to 64 KB of JSON; a visitor keeps up
to 1000 keys, and an artifact up to 20,000 records. `400` names bad input, `403` a shared write by a non-member, and
`413` a value or an artifact that is full.

The web app opens an artifact at its `url`, with no `/api` prefix:

| Request | Response |
| --- | --- |
| `GET /a/:artifactId` | The page: a frame with the artifact. A public visitor without a session gets a `golem-visitor` cookie; the runtime keeps their data under its hash. A signed-out person goes to `/login?next=/a/:artifactId` for a members artifact. |
| `GET /a/:artifactId/content` | `content`, with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`: it runs without the site's origin, so it cannot read Golem's cookies or call Golem |
| `POST /a/:artifactId/rpc` | `{ op, args }` → `{ result }`, as the session's user or the `golem-visitor` cookie's visitor. Only from Golem's own origin. |

With `share_url` set, its host serves public artifacts at `/:artifactId`, `/:artifactId/content`, and
`/:artifactId/rpc`, and answers `404` to everything else, members artifacts too. docs/artifacts-sharing.md shows how
to put that host on the internet while the rest of Golem stays private.

### Search (`src/search/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/search?q=…&limit=20` | | `{ results: SearchResult[], semantic: boolean }`; `semantic` is false while the model starts, and results then match words only |

### Integrations (`src/integrations/`)

| Request | Body | Response |
| --- | --- | --- |
Each request exists twice: under `/api/v1/workspaces/:workspaceId` for the workspace's integrations, and under
`/api/v1` for the person's own.

| Request | Body | Response |
| --- | --- | --- |
| `GET …/integrations` | | `Integration[]` |
| `POST …/integrations/:integrationId/credentials` | `{ label, secret }` | `Credential`; `400` unless `connect` is `"secret"` |
| `POST …/integrations/:integrationId/connect` | `{ phone }` for `"phone"` | `{ url }`: the integration's sign-in page; `{ code }` for `"phone"` |
| `POST …/integrations/:integrationId/sign-in` | `{ address }`; `{}` for `"phone"` | `Credential`; `400` when the address is not of the person's own sign-in of this place, the sign-in did not finish, or the number did not link within a minute |
| `DELETE …/credentials/:credentialId` | | `204` |

Where a person connects an integration says whose turns use it. A workspace's credentials serve the turns of every
member there; every member sees and deletes them. A person's own serve only their turns, in each of their workspaces;
only they see and delete them. A turn is for the author of the message it answers, the person whose request another
thread passes on, the creator of a routine, or the recipient of a reminder. Each tool call uses the newest credential
of that person, else the workspace's newest, unless the call names another of their accounts in its `account`
argument; `<integrationId>_accounts` lists them. The agents of a workspace get the tools of each integration that the
workspace or one of its members connected. Secrets never leave the server.

An integration with `connect: "sign-in"` is one or more MCP servers, such as Rohlík's, Google's, or Slack's. The app
shows a link to the `url` of `connect`; the person signs in there. Rohlík lets self-registered clients return only to
loopback addresses, and Slack only to https ones, so the sign-in ends on an error page at
`https://localhost/golem-sign-in?code=…&state=…`. The person pastes that address, and `sign-in` keeps the tokens as a
credential, labeled with the account's email when the server gives it. The agents then get the servers' tools as
`<integrationId>_<tool>`, in the codemode namespace of the integration. Google and Slack need Golem's own OAuth client;
`docs/integrations.md` shows how to set them up.

An integration with `connect: "phone"`, WhatsApp, links the person's number as a device. `connect` gives the code that
the person enters on their phone, in Linked devices; then `sign-in` waits up to a minute for the link.

### Routines (`src/routines/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/channels/:channelId/routines` | | `{ routines: Routine[], runs: RoutineRun[] }`; the 20 newest runs, newest first |
| `PUT /api/v1/routines/:routineId` | `{ enabled }` | `Routine` |
| `POST /api/v1/routines/:routineId/runs` | | `202`; the run shows in the list; `409` while it runs |
| `DELETE /api/v1/routines/:routineId` | | `204`; its thread stays |

People create and change routines by asking an agent in a thread: agents have the `routines_create`,
`routines_update`, `routines_delete`, `routines_list`, and `routines_test_script` tools.

### One-time reminders (`src/reminders/`)

Agents in every thread of a workspace, including its orchestrator, have `reminders_create`, `reminders_list`,
`reminders_update`, and `reminders_cancel`. A reminder belongs to that workspace and its source thread. It runs once when
its saved UTC time is due, or when Golem starts again after that time. Reminders have no user-facing web or JSON routes.

### Machines (`src/hands/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/machines` | | `{ machines: Machine[], pairing: Pairing \| null }`; poll it while `pairing` is set to see the machine arrive |
| `POST /api/v1/workspaces/:workspaceId/machines/pairing` | | `Pairing`; replaces the workspace's earlier pairing. `409` when `base_url` is not `https://` or Golem has no hands binaries |
| `DELETE /api/v1/workspaces/:workspaceId/machines/:machineId` | | `204` |

The machine calls these, without an account; the 16-character pairing code in the path is the credential. They follow
the contract of `hands/docs/pairing.md`, with Golem in the phone's place.

| Request | Response |
| --- | --- |
| `GET /hands/:code` | `hands/scripts/pair-install.sh`, with Golem's address, the pin of its TLS key, and the binaries' SHA-256 |
| `GET /hands/:code/hands-<os>-<arch>` | A binary from `hands/dist/`, which `hands/scripts/build-release.sh` builds |
| `POST /hands/:code/pair` | `{ phoneName, publicKey }`: the workspace's name and Ed25519 key. `400` on a malformed request, `404` once the code was used, `410` once it expired |

### LLM (`src/llm/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/llm` | | `Llm` |
| `POST /api/v1/llm/login` | | `Llm` with `login` set; open `verificationUri` and enter `userCode` |
| `POST /api/v1/llm/logout` | | `Llm` |
| `PUT /api/v1/llm/model` | `{ model }` | `Llm` |
| `PUT /api/v1/llm/effort` | `{ effort }` | `Llm`; `400` when the model does not support it |

Errors other than `401`, `204`, and `404` have the body `{ error: string }`.

## Isolation

- Workspaces share nothing except the LLM provider, which the server owner connects once in `/settings`.
- A public artifact is the one thing that people outside a workspace can open: its page, and the data its visitors
  keep. Its name is two words that people can remember, so it can be guessed: a client that opens 20 artifact links
  that do not exist in 10 minutes gets `429` until the 10 minutes end. On the public host the client is
  `CF-Connecting-IP`; on Golem's own address, the last `X-Forwarded-For` address. Keep private things in members
  artifacts.
- Each thread is one conversation in its workspace's Pi Durable session, a SQLite file in the workspace's directory.
- A machine belongs to one workspace, and every agent in that workspace can use it, whoever the agent works for. The
  machine trusts the workspace's own key, so pairing it with one workspace does not open it to another.
- A credential belongs to a workspace, for the turns of every member there, or to one person, for their own turns in
  each of their workspaces. A turn never uses another person's own credential. Secrets never leave the server.
