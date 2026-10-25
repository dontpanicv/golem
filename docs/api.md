# Golem API

The web app and the iOS app have the same functionality. The web app renders HTML on the server with Datastar; the
iOS app uses this JSON API. Both call the same server code.

## Authentication

Accounts are managed by [better-auth](https://www.better-auth.com). People sign in only with Google, and only with
an email in `allowed_emails` in `config/golem.toml`. There is no sign-up and no password. Native clients use bearer
tokens. The routes are in `src/accounts/`.

| Request | Response |
| --- | --- |
| `GET /api/v1/sign-in/google` | Redirect to Google. Open it in a web authentication session that waits for the `golem` scheme. |
| `GET /api/v1/sign-in/google/done` | Redirect to `golem://signed-in?token=<token>`, or `golem://signed-in?error=<message>` |
| `POST /api/auth/sign-out` | `{ success }` |

`done` hands over a token only to a sign-in that `GET /api/v1/sign-in/google` started in the same browser session,
and Google always asks which account to use. This keeps another app that claims `golem://` from getting a token.

Send `Authorization: Bearer <token>` on every `/api/v1` request. A `401` response means the token is missing or expired.

## Types

```ts
type User = { id: string; name: string; email: string };
type Workspace = { id: string; name: string };
type ThreadSummary = { id: string; channelId: string; title: string; updatedAt: number; settledAt: number | null }; // times are Unix milliseconds
type Channel = {
	id: string;
	name: string;
	summary: string | null; // what the channel is for and what goes on in it, as an agent last wrote it
	threads: ThreadSummary[]; // newest first
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
};
type FileRef = { id: string; name: string };
type ThreadFile = { id: string; name: string; size: number; time: number }; // size in bytes; ids are UUIDv7
type ThreadState = { thread: ThreadSummary; messages: Message[]; running: boolean };
type SearchResult = {
	uri: string; // thread:<id>, or a path under the workspace folder
	kind: "thread" | "note" | "file" | "capture";
	title: string;
	threadId: string | null;
	channelId: string | null;
	snippet: string;
	score: number;
	updatedAt: number;
};
type Member = { userId: string; name: string; email: string; role: "owner" | "admin" | "member" };
type Credential = { id: string; label: string; ownerName: string; createdAt: number };
type Integration = { id: string; name: string; secretLabel: string; credentials: Credential[] };
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
	threadId: string;
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

### Workspaces (`src/workspaces/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/me` | | `{ user: User, workspaces: Workspace[] }` |
| `POST /api/v1/workspaces` | `{ name }` | `Workspace`; the creator becomes owner, and the workspace gets a `general` channel |
| `GET /api/v1/workspaces/:workspaceId` | | `{ workspace: Workspace, channels: Channel[] }` |
| `POST /api/v1/workspaces/:workspaceId/channels` | `{ name }` | `Channel`; `409` if the name exists |
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
| `POST /api/v1/threads/:threadId/messages` | `{ text, voice? }` | `204` |
| `GET /api/v1/threads/:threadId/files` | | `{ files: ThreadFile[] }`, oldest first |
| `POST /api/v1/threads/:threadId/files` | multipart `files` | `{ files: ThreadFile[] }`: all files of the thread |
| `DELETE /api/v1/threads/:threadId/files/:fileId` | | `{ files: ThreadFile[] }`: the files left. Messages keep the name of a deleted file. |
| `GET /api/v1/threads/:threadId/files/:fileId` | | The file. Pictures, PDFs, plain text, audio, and video are `inline`; other kinds are `attachment` and `application/octet-stream`. |

To attach files to a new thread or a message, send the same fields as a `multipart/form-data` form with one `files`
part per file instead of JSON. A message then needs text, files, or both; a thread without text takes the name of its
first file. The thread's agent sees each attached file by name and id, and reads files with its `list_files` and
`read_file` tools.

The orchestrator is the one thread of a workspace that never ends: the workspace opens on it, and its agent gives
work to the threads of the channels. It is in the first channel, but no `Channel.threads` list shows it, and it cannot
be settled. Its agent remembers all of the thread: see `src/threads/memory.ts`.

`voice: true` marks a message spoken in a conversation on the iPhone: the agent writes its answer to be read aloud, and
the message steers a run at work instead of waiting for it to end.

### Artifacts (`src/artifacts/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/threads/:threadId/artifacts` | | `{ artifacts: Artifact[] }`, newest first |
| `GET /api/v1/artifacts/:artifactId` | | `{ artifact: Artifact, records: ArtifactRecord[], content: string }` |
| `PUT /api/v1/artifacts/:artifactId` | `{ visibility }` | `Artifact` |
| `DELETE /api/v1/artifacts/:artifactId` | | `204`; its data goes too |
| `POST /api/v1/artifacts/:artifactId/rpc` | `{ op, args }` | `{ result }`: a call of the artifact's `golem` runtime, as the signed-in user |
| `DELETE /api/v1/artifacts/:artifactId/data` | | `204`; every record and visitor goes |
| `DELETE /api/v1/artifacts/:artifactId/records/:recordId` | | `204` |

An artifact is a page or a small app that an agent makes in a thread with its `create_artifact`, `update_artifact`,
`edit_artifact`, `read_artifact`, `list_artifacts`, `artifact_data`, and `set_artifact_data` tools. `content` is the
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
| `GET /api/v1/workspaces/:workspaceId/integrations` | | `Integration[]` |
| `POST /api/v1/workspaces/:workspaceId/integrations/:integrationId/credentials` | `{ label, secret }` | `Credential` |
| `DELETE /api/v1/workspaces/:workspaceId/credentials/:credentialId` | | `204` |

Credentials belong to the workspace: every member sees and deletes them, and the agents use the newest credential of
each integration through the tools of its connector. Secrets never leave the server.

### Routines (`src/routines/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/channels/:channelId/routines` | | `{ routines: Routine[], runs: RoutineRun[] }`; the 20 newest runs, newest first |
| `PUT /api/v1/routines/:routineId` | `{ enabled }` | `Routine` |
| `POST /api/v1/routines/:routineId/runs` | | `202`; the run shows in the list; `409` while it runs |
| `DELETE /api/v1/routines/:routineId` | | `204`; its thread stays |

People create and change routines by asking an agent in a thread: agents have the `create_routine`,
`update_routine`, `delete_routine`, `list_routines`, and `test_script` tools.

### Machines (`src/hands/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/machines` | | `{ machines: Machine[], pairing: Pairing \| null }`; poll it while `pairing` is set to see the machine arrive |
| `POST /api/v1/workspaces/:workspaceId/machines/pairing` | | `Pairing`; replaces the workspace's earlier pairing. `409` when `base_url` is not `https://` or Golem has no hands binaries |
| `DELETE /api/v1/workspaces/:workspaceId/machines/:machineId` | | `204` |

The machine calls these, without an account; the six-character pairing code in the path is the credential. They follow
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
- Integration settings belong to one user in one workspace. A credential is private to its owner, or shared with
  every agent in the workspace when `shared` is true. Secrets never leave the server.
