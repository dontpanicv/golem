# Golem API

The web app and the iOS app have the same functionality, and both use this JSON API. The iOS app sends a bearer token;
the web app sends its session cookie, and a request that names another origin than `base_url` gets `403`.
A JSON body over 1 MB, an artifact call over 1 MB, a pairing request over 64 KB, and any body over 100 MB get `413`.

## Authentication

Accounts are managed by [better-auth](https://www.better-auth.com). People sign in only with Google, and only with
an email in `allowed_emails` in `config/golem.toml`. There is no sign-up and no password. Native clients use bearer
tokens; the web app uses better-auth's session cookie. The routes are in `src/accounts/`.

| Request | Response |
| --- | --- |
| `GET /api/v1/sign-in/google?challenge=<challenge>` | Redirect to Google. The iOS app opens it in a web authentication session that waits for `https://<server>/api/v1/sign-in/google/signed-in`. `challenge` is the base64url SHA-256 of a random verifier (PKCE, RFC 7636); `400` without one. |
| `GET /api/v1/sign-in/google/done` | Redirect to `/api/v1/sign-in/google/signed-in?code=<code>`, or `?error=<message>` |
| `GET /api/v1/sign-in/google/signed-in` | A page that asks a browser without the app to open the app |
| `POST /api/v1/sign-in/google/token` | `{ code, verifier }` → `{ token }`; `400` when the code is unknown, used, older than 60 seconds, or not of that verifier |
| `GET /.well-known/apple-app-site-association` | `{ webcredentials: { apps: [ios_app_id] } }`; `404` without `ios_app_id` in `config/golem.toml` |
| `POST /api/auth/sign-in/social` | `{ provider: "google", callbackURL }` → `{ url }`: the web app opens `url`, and Google sends the person back to `callbackURL` with a session cookie. A failed sign-in comes back to `/login?error=…&error_description=…`. |
| `POST /api/auth/sign-out` | `{ success }` |

`done` gives a code only to a sign-in that `GET /api/v1/sign-in/google` started in the same browser session, and only
for the session that the Google step of that sign-in made; Google always asks which account to use. The code gives the
token once, only with the verifier of the sign-in's challenge. The web authentication session gives the `signed-in`
address only to the app that the server's apple-app-site-association file names, so the iOS app needs https.

Send `Authorization: Bearer <token>`, or the session cookie, on every `/api/v1` request. A `401` response means the
token or the session is missing or expired. Golem checks `allowed_emails` on every request: after a restart without
their email, a person gets `401`, also from every `/api/auth` route except sign-out. A person who leaves a workspace
stops getting its event streams.

## Types

```ts
type User = { id: string; name: string; email: string };
type Workspace = { id: string; name: string; role: "owner" | "member" }; // `role` is the person's
type ThreadSummary = { id: string; channelId: string; title: string; updatedAt: number; settledAt: number | null }; // times are Unix milliseconds
type Channel = {
	id: string;
	name: string;
	ownerId: string | null; // the person a private channel belongs to, who alone sees it; null: every member sees it
	summary: string | null; // what the channel is for and what goes on in it, as the model last wrote it with the brief
	icon: string | null; // one emoji, shown in place of the # before the name; the model chooses it for a new channel and again at each new thread
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
	tool: string | null; // the tool's name, such as "web_search"; "from_thread" is what another thread's agent sent, which started the work: its text the link to that thread, its output the whole message
	input: string | null; // a tool call's arguments as JSON, cut at 1000 characters
	output: string | null; // the start of a tool call's result, cut at 1000 characters; null until it has one
	running: boolean;
	failed: boolean;
};
type FileRef = { id: string; name: string };
type SavedFile = { id: string; name: string; size: number; time: number }; // size in bytes; ids are UUIDv7
type ThreadState = { thread: ThreadSummary; messages: Message[]; running: boolean; approvals: Approval[] };
type Approval = {
	id: string;
	tool: string; // such as "hands_exec"
	text: string; // what the action does, such as "Run on bender: make deploy"
	approverId: string | null; // the person who may answer; null for any member
	allowsTurn: boolean; // "turn" also allows the rest of the turn's flagged commands on its machine; false for an action as a person, such as sending a message
	expiresAt: number; // the agent gets an error after this
};
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
type RecentSearch = { query: string; searchedAt: number }; // newest first; the same query again, in any case, only moves to the top
type Member = { userId: string; name: string; email: string; role: "owner" | "admin" | "member" };
type Credential = { id: string; label: string; ownerName: string; createdAt: number };
type Integration = { id: string; name: string; connect: "secret" | "sign-in" | "phone"; secretLabel: string | null; labeled: boolean; address: boolean; guide: string[]; client: { clientId: string | null; changeable: boolean } | null; credentials: Credential[] }; // secretLabel: for "secret"; labeled: the person names a credential, else Golem names it from the secret, as Slack's by its workspace; address: the secret also needs the address of the person's own server; guide: the steps that set it up, in Markdown; client: Golem's own OAuth client, and whether this person may set it
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
	id: string; // four words, such as "amber-fox-lake-moss" (older ones have two); a name is never given out again
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
	name: string; // what agents and people call it; a new machine does not take a name that a turn sees with it
	hostname: string | null;
	addresses: string[];
	port: number;
	certSha256: string; // the hands listener's certificate, which Golem pins
	os: string; // "macos" or "linux"
	arch: string;
	version: string; // hands version when it paired
	pairedAt: number;
	pairedBy: string | null; // the member who paired it; null for a machine paired before Golem kept it
	workspaceId: string | null; // the workspace it is paired with; null for the own machine of `pairedBy`
};
type Pairing = { command: string; expiresAt: number }; // run `command` on the machine before `expiresAt`
type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Llm = {
	connected: boolean;
	owner: boolean; // whether the person is the server's owner, the first email in `allowed_emails`
	provider: string; // "ChatGPT"
	model: string; // a model id
	effort: Effort; // the chosen effort, moved to the nearest level the model supports
	models: { id: string; name: string; efforts: Effort[] }[]; // from the provider's model catalog
	login: { userCode: string; verificationUri: string; expiresAt: number } | null; // set for the owner while a device login waits
	error: string | null; // the last login error
};
```

## Endpoints

Golem has one workspace, the family's; nobody makes or deletes one. Workspace paths answer `404` to users who are not
members of the workspace, and the paths of a private channel, its threads, files, artifacts, and routines answer `404`
to everyone but its person.

Every delete is soft: Golem keeps what was deleted, hidden, and no route, page, tool, or search shows it again.

### Workspaces (`src/workspaces/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/me` | | `{ user: User, workspaces: Workspace[] }`; the first person to sign in starts Golem's one workspace, with a `general` channel, and is its owner |
| `GET /api/v1/workspaces/:workspaceId` | | `{ workspace: Workspace, channels: Channel[] }`: the channels every member sees, and the person's own private ones |
| `PUT /api/v1/workspaces/:workspaceId` | `{ name }` | `Workspace`; `403` for a member who is not an owner |
| `POST /api/v1/workspaces/:workspaceId/channels` | `{ name, private? }` | `Channel`; a `private` one is the person's own. `409` if the name exists, also as another person's private channel |
| `DELETE /api/v1/workspaces/:workspaceId/channels/:channelId` | | `204`; its threads, files, artifacts, and routines go with it, and the orchestrators move to the next channel that every member sees; `409` for the last such channel |
| `GET /api/v1/workspaces/:workspaceId/facts` | | `{ text }`: facts that the family writes by hand, such as names, birthdays, and places; every agent of the workspace reads them; `""` until someone writes them |
| `PUT /api/v1/workspaces/:workspaceId/facts` | `{ text }` | `{ text }`; every member can write them; `400` over 20,000 characters |
| `GET /api/v1/workspaces/:workspaceId/members` | | `Member[]` |
| `POST /api/v1/workspaces/:workspaceId/members` | `{ email }` | `Member`; the person must have signed in once; `403` for a member who is not an owner |

### Threads (`src/threads/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/orchestrator` | | `ThreadSummary` of the person's own orchestrator in the workspace; the first call makes it |
| `POST /api/v1/workspaces/:workspaceId/threads` | `{ channelId, text }` | `ThreadSummary`; `text` becomes the first message, and its first line the title until the model names the topic in a few words |
| `GET /api/v1/threads/:threadId` | | `ThreadState` |
| `POST /api/v1/workspaces/:workspaceId/threads/:threadId/settled` | `{ settled: boolean }` | `ThreadSummary`; settled threads stay available in their channel; `400` for the orchestrator |
| `GET /api/v1/threads/:threadId/events` | | Server-sent events: `event: thread`, `data: ThreadState` after every change |
| `POST /api/v1/threads/:threadId/messages` | `{ text, voice?, requestId? }` | `204`; a retry with the same `requestId` sends nothing again |
| `POST /api/v1/threads/:threadId/approvals/:approvalId` | `{ allow: boolean, scope: "once" \| "turn" }` | `204`; `allow` runs the command once, or with `"turn"` also the rest of the turn's flagged commands on that machine. `403` for a person who is not the approver; `404` when the approval ended or the person is not a member |
| `POST /api/v1/threads/:threadId/stop` | | `204`; the agent drops the messages it has not read yet and ends its run. Threads it asked for something, and that still work on that message, stop too |
| `GET /api/v1/workspaces/:workspaceId/working` | | Server-sent events: `event: working`, `data: { threadIds: string[] }`, the threads whose agent works, at once and after every change. Load the workspace again when it changes: agents start threads and channels as they work |
| `GET /api/v1/workspaces/:workspaceId/channels/:channelId/brief` | | `{ brief: Brief \| null }`: what the channel is for, where it is now, its decisions, its open questions, and what each person wants; `null` before the first |
| `GET /api/v1/workspaces/:workspaceId/channels/:channelId/files` | | `{ files: SavedFile[] }`, oldest first |
| `POST /api/v1/workspaces/:workspaceId/channels/:channelId/files` | multipart `files` | `{ files: SavedFile[] }`: all files of the channel |
| `GET /api/v1/workspaces/:workspaceId/files` | | `{ files: SavedFile[] }`: the workspace's own files, which the orchestrator keeps, oldest first |
| `POST /api/v1/workspaces/:workspaceId/files` | multipart `files` | `{ files: SavedFile[] }`: all of the workspace's own files |
| `GET /api/v1/workspaces/:workspaceId/files/:fileId` | | Any file of the workspace, in a channel or its own. Pictures, PDFs, plain text, audio, and video are `inline`; other kinds are `attachment` and `application/octet-stream`. |
| `GET /api/v1/workspaces/:workspaceId/files/:fileId/picture` | | A JPEG of a picture file, also HEIC, at most 1024 pixels long, for its thumbnail in a message. `404` for another kind of file. |
| `DELETE /api/v1/workspaces/:workspaceId/files/:fileId` | | `{ files: SavedFile[] }`: the files left where it was. Messages keep the name of a deleted file. |

Files belong to a channel: every thread of the channel sees them, also after a thread is settled. The orchestrator
belongs to no channel, so its files are the workspace's own. To attach files to a new thread or a message, send the
same fields as a `multipart/form-data` form with one `files` part per file instead of JSON; the files go to the
thread's channel, or the workspace for the orchestrator. A message then needs text, files, or both; a thread without
text takes the name of its first file. A message's `FileRef` opens at `/api/v1/workspaces/:workspaceId/files/:fileId`.
The agents see each attached file by name and id; `list_files` lists the files of their channel, and `read_file` reads
any file of the workspace by its id. `save_file` with `replaces` saves a new version of a file of their channel, which
keeps its id, and `delete_file` deletes a file of their channel. With `channel`, these three work in another channel
that the turn's realm sees, so a file goes to the channel of its topic without a thread there; another person's private
channel is never one.

Each member has an orchestrator of their own in the workspace, their personal assistant: one thread that never ends,
which the workspace opens on, and whose agent gives work to the threads of the channels. Only its person reads and
writes it: for anyone else, its routes answer `404`, and search, recall, routines, and other agents leave it out. It is
in the first channel, but no `Channel.threads` list shows it, and it cannot be settled. Its agent remembers every
message of its own thread, of every thread of the channels every member sees, and of its person's private channels, and
no other person's orchestrator or private channel: see `src/threads/memory.ts`. The workspace's one orchestrator from before each member had one belongs to the person who
made the workspace.

Each channel has a brief, which the model writes again from the new messages of the channel's threads when they are
quiet for 10 minutes or settled, and the channel's summary with it. Every thread of the channel reads the brief and the
list of the channel's threads before each answer: see `src/threads/brief.ts`.

The web app keeps a text message that it cannot send yet, such as without a connection, and sends it later with a
`requestId`, so a message that reached Golem before its response was lost stays one message.

A message steers a run at work for its author: the agent reads it after its current tool calls, instead of after its
answer. A message waits for a run at work for another person, so that run keeps the credentials of its own person.

`voice: true` marks a message spoken in a conversation on the iPhone: the agent writes its answer to be read aloud.

### Notifications (`src/notifications/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/notifications` | | `Inbox` |
| `POST /api/v1/workspaces/:workspaceId/notifications/read` | `{ id? }` | `Inbox`; marks one notification read, or all of them without `id` |
| `POST /api/v1/devices` | `{ token, environment: "sandbox" \| "production" }` | `204`; the device gets the person's pushes, and no more of another person's. A person keeps their 10 newest devices |
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
| `DELETE /api/v1/artifacts/:artifactId/data` | | `204`; every record and visitor goes, and the records move aside, so the limits are free again |
| `DELETE /api/v1/artifacts/:artifactId/records/:recordId` | | `204` |

An artifact is a page or a small app that an agent makes in a thread with its `artifacts_create`, `artifacts_update`,
`artifacts_edit`, `artifacts_read`, `artifacts_list`, `artifacts_data`, and `artifacts_set_data` tools. It belongs to the
thread's channel, or to a channel the agent names: every thread of the channel sees it, and it stays after the thread
is settled. The orchestrator's belong to the workspace. `content` is the
agent's HTML with a content policy and Golem's `golem` runtime at the start of the page. The policy lets scripts,
styles, and fonts come only from cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com, and Google Fonts, and pictures
only from the page itself. The runtime sends each call as a message: to `window.webkit.messageHandlers.golem` in a
web view, or else on a `MessagePort` that the link's page gives the frame at its first load. Its reply goes back
through `window.__golemReceive({ golem: 1, id, result })`, or `{ golem: 1, id, error }`, or on the port. The iOS app
loads `content` with no base URL, and answers each message of the main frame with `rpc`. It opens a link that a
person taps in the browser, and nothing else replaces the page.

The runtime the page calls:

| Call | `op` and `args` | Who |
| --- | --- | --- |
| `golem.ready`, `golem.me` | `me`: `{}` → `{ id, name, member }`; a member is their user id and name, and every other visitor an id of this artifact only, with no name until `setName` | everyone |
| `golem.setName(name)` | `name`: `{ name }` → the new `me` | everyone |
| `golem.mine.get/set/delete/list` | `get`, `set`, `delete`, `list`: `{ scope: "mine", key, value?, prefix? }` | everyone, on their own records |
| `golem.everyone.list(prefix?)` | `list`: `{ scope: "everyone", prefix }` → `ArtifactRecord[]` of visitors | everyone |
| `golem.shared.get/set/delete/list` | the same with `scope: "shared"` | everyone reads; members change |

`list` gives `{ key, value, updatedAt }[]` for `mine` and `shared`. A value is up to 64 KB of JSON; a visitor keeps up
to 1000 keys, and an artifact up to 20,000 records, 10 MB of values, and 10,000 visitors; a visitor past that can look and
write, but has no name. `400` names bad input, `403` a shared write by a non-member, and
`413` a value or an artifact that is full.

The web app opens an artifact at its `url`, with no `/api` prefix:

| Request | Response |
| --- | --- |
| `GET /a/:artifactId` | The page: a frame with the artifact. A public visitor without a session gets a `golem-visitor` cookie; the runtime keeps their data under its hash. A signed-out person goes to `/login?next=/a/:artifactId` for a members artifact. |
| `GET /a/:artifactId/content` | `content`, with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads` and the page's content policy: it runs without the site's origin, so it cannot read Golem's cookies or call Golem, and it loads no pictures from other sites |
| `POST /a/:artifactId/rpc` | `{ op, args }` → `{ result }`, as the session's user or the `golem-visitor` cookie's visitor. Only from Golem's own origin. |

With `share_url` set, its host serves public artifacts at `/:artifactId`, `/:artifactId/content`, and
`/:artifactId/rpc`, and answers `404` to everything else, members artifacts too. docs/artifacts-sharing.md shows how
to put that host on the internet while the rest of Golem stays private.

### Search (`src/search/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/search?q=…&limit=20` | | `{ results: SearchResult[], semantic: boolean }`; `semantic` is false while the model starts, and results then match words only |
| `GET /api/v1/workspaces/:workspaceId/searches` | | `{ searches: RecentSearch[] }`: the person's own 10 newest |
| `POST /api/v1/workspaces/:workspaceId/searches` | `{ query }` | `{ searches: RecentSearch[] }`; the apps save a query when the person presses Enter or opens a result |

### Integrations (`src/integrations/`)

Each request exists twice: under `/api/v1/workspaces/:workspaceId` for the workspace's integrations, and under
`/api/v1` for the person's own.

| Request | Body | Response |
| --- | --- | --- |
| `GET …/integrations` | | `Integration[]` |
| `POST …/integrations/:integrationId/credentials` | `{ label?, secret, address? }`; `label` when the integration is `labeled`, `address` when it has `address` | `Credential`; `400` unless `connect` is `"secret"`, or when the integration cannot use the secret, such as a Slack cURL whose session Slack refuses |
| `POST …/integrations/:integrationId/connect` | `{ phone }` for `"phone"` | `{ url }`: the integration's sign-in page; `{ code }` for `"phone"` |
| `POST …/integrations/:integrationId/sign-in` | `{ address }`; `{}` for `"phone"` | `Credential`; `400` when the address is not of the person's own sign-in of this place, the sign-in did not finish, or the number did not link within a minute |
| `DELETE …/credentials/:credentialId` | | `204` |

| Request | Body | Response |
| --- | --- | --- |
| `PUT /api/v1/integrations/:integrationId/client` | `{ clientId, clientSecret }` | `204`; the next sign-in uses it, at once. `403` unless the person is the server's owner, `404` unless the integration has `client` |

Where a person connects an integration says whose turns use it. A workspace's credentials serve the turns of every
member there; every member sees and deletes them. A person's own serve only their turns, in each of their workspaces;
only they see and delete them. A turn is for the author of the message it answers, the person whose request another
thread passes on, the person who last wrote a routine's instructions or script, or the person who asked for a
reminder or last changed it. Each tool call uses the newest credential of that person, else the workspace's newest,
unless the call names another of their accounts in its `account` argument; `<integrationId>_accounts` lists them. The
agents of a workspace get the tools of each integration that the workspace or one of its members connected. Secrets
never leave the server.

An integration with `connect: "sign-in"` is one or more MCP servers, such as Rohlík's or Plaud's, or an API that
Golem's own tools call, such as Google's. The app shows a link to the `url` of `connect`; the person signs in there. Rohlík lets self-registered clients return only to
loopback addresses, so the sign-in ends on an error page at
`https://localhost/golem-sign-in?code=…&state=…`. The person pastes that address, and `sign-in` keeps the tokens as a
credential, labeled with the account's email when the server gives it. The agents then get the servers' tools as
`<integrationId>_<tool>`, in the codemode namespace of the integration. Golem lists a server's tools with the
workspace's sign-in, else with a member's own; the list has only tool names and schemas. Google's tools run gog with
an access token that Golem renews with the refresh token.

An integration with `client` signs in with Golem's own OAuth client, because its sign-in server does not register
clients: Google. The server's owner sets the client in Settings; until then, only the owner sees the
integration, and `connect` answers `400`. `docs/integrations.md` shows how to make the clients.

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
`routines_update`, `routines_delete`, `routines_list`, and `routines_test_script` tools. A routine runs as the person
who last wrote its instructions or script; a change of only its name, schedule, or pause keeps that person. Only that
person tests a script with the values the routine stored. When that person is no longer a member, each run fails until
a member changes the routine. A run that a stop or a restart of Golem cuts off stays `running`, and ends when Golem
starts again and its agent answers; the script does not run again.

### One-time reminders (`src/reminders/`)

Agents in every thread of a workspace, including its orchestrator, have `reminders_create`, `reminders_list`,
`reminders_update`, and `reminders_cancel`. A reminder belongs to that workspace and its source thread. It runs once when
its saved UTC time is due, or when Golem starts again after that time. Its turn is for the person who asked for it or
last changed it, not for its recipient; a reminder from before this rule uses only the workspace's credentials.
Reminders have no user-facing web or JSON routes.

### Machines (`src/hands/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/machines` | | `{ machines: Machine[], pairing: Pairing \| null }`; poll it while `pairing` is set to see the machine arrive |
| `POST /api/v1/workspaces/:workspaceId/machines/pairing` | | `Pairing`; replaces the workspace's earlier pairing. `409` when `base_url` is not `https://` or Golem has no hands binaries |
| `DELETE /api/v1/workspaces/:workspaceId/machines/:machineId` | | `204` |

The same routes without `/workspaces/:workspaceId` are the person's own machines, for their turns in each of their
workspaces; a person sees and removes only their own. A machine can pair with a workspace and as a person's own: it
trusts each key, and a turn of that person shows it once, as their own.

The machine calls these, without an account; the 16-character pairing code in the path is the credential. They follow
the contract of `hands/docs/pairing.md`, with Golem in the phone's place.

| Request | Response |
| --- | --- |
| `GET /hands/:code` | `hands/scripts/pair-install.sh`, with Golem's address, the pin of its TLS key, and the binaries' SHA-256 |
| `GET /hands/:code/hands-<os>-<arch>` | A binary from `hands/dist/`, which `hands/scripts/build-release.sh` builds |
| `POST /hands/:code/pair` | `{ phoneName, publicKey }`: the workspace's name and Ed25519 key. `400` on a malformed request, also for a loopback or link-local address or a `localhost` name, `404` once the code was used, `410` once it expired |

### LLM (`src/llm/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/llm` | | `Llm` |
| `POST /api/v1/llm/login` | | `Llm` with `login` set; open `verificationUri` and enter `userCode` |
| `POST /api/v1/llm/logout` | | `Llm` |
| `PUT /api/v1/llm/model` | `{ model }` | `Llm` |
| `PUT /api/v1/llm/effort` | `{ effort }` | `Llm`; `400` when the model does not support it |

Only the server's owner, the first email in `allowed_emails`, logs in, logs out, and chooses the model and the effort;
these routes answer `403` to other people.

### Server (`src/app/`)

| Request | Body | Response |
| --- | --- | --- |
| `POST /api/v1/server/restart` | | `202`; Golem stops, and its service starts it again with the configuration of `config/golem.toml`. Turns continue after the restart. `403` for a person who is not the server's owner. |

Errors other than `401`, `204`, and `404` have the body `{ error: string }`.

## Isolation

- Every member sees the channels that are not private, with their threads, files, artifacts, and routines. A private
  channel and all of it is its person's alone. An agent's turn sees the channels every member sees and the private
  ones of one person: the person of an orchestrator or of a private channel, or in another channel the person whose
  message the turn answers (also through a relay, routine, or reminder). What that turn writes there, every member
  reads. Its tools, recall, routines, and reminders follow this rule; notifications and memory follow the thread, so a
  thread every member reads goes to every orchestrator. A thread of a channel may still report back to the
  orchestrator that gave it work.
- Search is one index of the workspace; each search leaves out what the person may not see before it ranks, so
  neither the scores nor the limit depend on another person's private data.
- The LLM provider, which the server's owner, the first email in `allowed_emails`, connects once in `/settings`, serves
  every member.
- A public artifact is the one thing that people outside a workspace can open: its page, and the data its visitors
  keep. Its name is four words that people can remember, about 1.6e8 names; names from before have two words and can
  be guessed, so make such an artifact again. A client that opens 20 artifact links in 10 minutes that do not exist,
  or that are for members while it is signed out, gets `429` until the 10 minutes end. On the public host the client
  is `CF-Connecting-IP`; on Golem's own address, the last `X-Forwarded-For` address, which only a Golem with
  `host = "127.0.0.1"` behind Caddy can trust. An IPv6 client is its /48 network. Keep private things in members
  artifacts.
- Each thread is one conversation in its workspace's Pi Durable session, a SQLite file in the workspace's directory.
- A machine belongs to a workspace, and every agent in that workspace can use it, whoever the agent works for; or it is
  a person's own, and only the turns of that person use it, in each of their workspaces. The machine trusts the key of
  that workspace or person, so pairing it with one does not open it to another. A command on a machine that
  [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) flags, such as `rm -rf` or
  `git reset --hard`, waits for an approval (`ThreadState.approvals`, with a notification) from the member who paired
  the machine when the turn is another person's, and from the turn's person otherwise; a command that dcg cannot judge
  waits too. Other commands, file reads, and file writes run at once.
- A connector tool that acts as a person, such as `google_mail_send`, `google_mail_send_draft`, `slack_send`,
  `whatsapp_send`, or `whatsapp_send_file`, waits for an approval before every call, which shows what it sends: from the person who added the credential that it uses while
  they are a member, else from the turn's person. `"turn"` allows only that call. A routine's script cannot call it.
- Agents reach public addresses only: the browser and `save_file` go through Golem's egress proxy, which refuses
  loopback, private, link-local, and other non-public addresses after each DNS answer and redirect. Each person of a
  thread has a browser of their own, with their own logins.
- A codemode script stops after 15 minutes. A routine runs at most every 15 minutes.
- A credential belongs to a workspace, for the turns of every member there, or to one person, for their own turns in
  each of their workspaces. A turn never uses another person's own credential. Secrets never leave the server.
