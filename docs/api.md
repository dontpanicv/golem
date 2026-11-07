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
type User = { id: string; name: string; email: string; picture: string | null }; // picture: the address of the profile picture, or null for none; until a person uploads one, it is a copy of their Google picture, which Golem makes once
type Workspace = { id: string; name: string; role: "owner" | "member" }; // `role` is the person's
type ThreadSummary = { id: string; channelId: string; title: string; updatedAt: number; settledAt: number | null }; // times are Unix milliseconds
type ListedThread = ThreadSummary & { channel: string }; // channel name, without #
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
	snippet: string; // Markdown around the term; "" for a file found by its name
	score: number;
	updatedAt: number;
};
type RecentSearch = { query: string; searchedAt: number }; // newest first; the same query again, in any case, only moves to the top
type Member = { userId: string; name: string; email: string; picture: string | null; role: "owner" | "admin" | "member" };
type Credential = { id: string; label: string; ownerId: string; ownerName: string; shared: boolean; watched: boolean; createdAt: number }; // ownerId: the person who connected it, who alone shares, watches, or deletes it; shared: every member's turns use it, else only its owner's; watched: its owner lets Golem read it for them (`src/intake/`)
type Integration = { id: string; name: string; connect: "secret" | "sign-in" | "phone"; secretLabel: string | null; labeled: boolean; address: boolean; username: string | null; guide: string[]; watchable: boolean; client: { clientId: string | null; changeable: boolean } | null; credentials: Credential[] }; // watchable: Golem can read a credential of it for its owner; secretLabel: for "secret"; labeled: the person names a credential, else Golem names it from the secret, as Slack's by its workspace; address: the secret, or for "sign-in" the MCP servers, also needs the address of the person's own server; username: the name of the account that the secret also needs, such as "Email", which names the credential; guide: the steps that set it up, in Markdown; client: Golem's own OAuth client, and whether this person may set it
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
	schedule: string | null; // a cron expression in the server's time zone; null for a routine at a place
	place: { id: string; name: string; latitude: number; longitude: number; radius: number; event: "arrive" | "leave"; personId: string } | null; // a routine at a place runs each time personId arrives or leaves; null: a routine on a schedule
	instructions: string;
	script: string | null; // code mode JavaScript that collects what is new before the agent sees it
	enabled: boolean;
	nextRunAt: number | null; // null while paused, and for a routine at a place
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
type Place = {
	id: string;
	name: string; // unique among its owner's places
	latitude: number;
	longitude: number;
	radius: number; // meters, 100 to 5000
	ownerId: string; // the member who added it, who alone changes or removes it
	ownerName: string;
	shared: boolean; // false: only its owner's turns use it
};
type Feedback = {
	id: string;
	kind: "error" | "missing" | "better"; // a tool failed or answered wrong; no tool can do it; an easier or faster way
	tool: string | null; // the tool it is about
	summary: string; // one line
	detail: string;
	threadId: string | null; // the thread of the turn; null when the owner does not see it, such as another person's private channel
	createdAt: number;
};
type Machine = {
	id: string;
	name: string; // what agents and people call it; unique in the workspace, so a new machine with a taken name gets a number
	hostname: string | null;
	addresses: string[];
	port: number;
	certSha256: string; // the hands listener's certificate, which Golem pins
	os: string; // "macos" or "linux"
	arch: string;
	version: string; // hands version when it paired
	pairedAt: number;
	pairedBy: string; // the member who paired it, who alone shares or removes it
	pairedByName: string;
	shared: boolean; // every member's turns use it, else only the turns of `pairedBy`
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
type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }; // tokens; input leaves out cacheRead, the tokens read from the prompt cache; cost in US dollars at the model's list price, which a ChatGPT login does not pay
type UsageSource = "thread" | "orchestrator" | "routine" | "reminder" | "intake" | "background"; // intake: what Golem reads in watched accounts; background: briefs, memory, names, emojis, and what Golem learns
type Usage = {
	days: (UsageTotals & { day: string })[]; // "YYYY-MM-DD" in UTC, oldest first; a day without use is left out
	total: UsageTotals;
	sources: (UsageTotals & { source: UsageSource })[]; // most cost first
	models: (UsageTotals & { model: string })[]; // "provider/model", or "tool:<name>" for a tool's own model calls
	threads: (UsageTotals & { threadId: string; title: string })[]; // the 10 that cost most, of those the person sees
	people: (UsageTotals & { userId: string; name: string })[] | null; // only for the server's owner; userId "" is work for nobody, named "Golem"
};
type Learned = {
	id: number;
	kind: "about" | "howto"; // about: a fact about a person; howto: how to do a task for the family in a channel
	personId: string | null; // the person an "about" is about
	channelId: string | null; // the channel of a "howto"; null for one of the person's own orchestrator
	realm: string | null; // the person who alone sees it, because it came from their private channel or orchestrator; null: every member
	text: string;
	threadId: string | null; // where Golem learned it
	updatedAt: number;
};
type Suggestion = {
	id: string;
	kind: "routine" | "reminder" | "channel";
	name: string; // the routine's name, the reminder's text, or the private channel's name
	text: string; // the routine's instructions, the reminder's text, or what the channel is for
	schedule: string | null; // a routine's cron expression in the server's time zone
	at: number | null; // when the reminder is due, or the routine's first run; null for a channel
	channelId: string; // where the routine would run
	threadId: string; // the thread whose messages gave it
	createdAt: number;
};
type Reminder = {
	id: string;
	threadId: string; // where its agent reminds
	recipientId: string;
	createdBy: string | null; // the person who asked for it
	text: string;
	dueAt: number; // for a reminder at a place: when it was made, until the person arrives or leaves
	timeZone: string;
	place: { id: string; name: string; latitude: number; longitude: number; radius: number; event: "arrive" | "leave" } | null; // what a reminder at a place waits for; null: a reminder at a time
	triggeredAt: number | null; // when the person arrived at or left the place of a reminder at a place, as their iPhone reported
	notBefore: number | null; // a reminder at a place fires only from this time; if the person is already there for an arrival, it fires then
	notAfter: number | null; // a reminder at a place fires at this time anyway when its event has not come
	deliveredAt: number | null;
	cancelledAt: number | null;
};
type Upcoming = {
	routines: Routine[]; // every routine the person sees
	reminders: Reminder[]; // pending, for the person or from them, soonest first
	suggestions: Suggestion[]; // oldest first; at most 3
	approvals: { threadId: string; approval: Approval }[]; // what waits for the person to allow it
};
type WatchedPlace = {
	id: string;
	name: string;
	latitude: number;
	longitude: number;
	radius: number;
	reminders: { id: string; text: string; event: "arrive" | "leave" }[]; // the pending reminders here, which the iPhone shows itself without a connection
};
type ActivityState = { status: "working" | "waiting"; title: string; threads: number }; // a Live Activity's content state: waiting: for the person to allow an action; title: the thread that works now; threads: how many work on it now
```

## Endpoints

Golem has one workspace, the family's; nobody makes or deletes one. Workspace paths answer `404` to users who are not
members of the workspace, and the paths of a private channel, its threads, files, artifacts, and routines answer `404`
to everyone but its person.

Every delete is soft: Golem keeps what was deleted, hidden, and no route, page, tool, or search shows it again.

### Workspaces (`src/workspaces/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/me` | | `{ user: User, workspaces: Workspace[], owner: boolean }`; the first person to sign in starts Golem's one workspace, with a `general` channel, and is its owner. `owner`: the person is the server's owner, the first of `allowed_emails` |
| `POST /api/v1/me/picture` | `multipart/form-data` with one JPEG, PNG, or WebP file | `{ picture }`: the new address; the apps send a 256 px square. `400` for another kind, `413` over 1 MB |
| `DELETE /api/v1/me/picture` | | `204`; the person shows their initial, also in place of their Google picture |
| `GET /api/v1/pictures/:pictureId` | | The picture, for its person and the members of their workspace, else `404`. A new picture gets a new address, so the browser keeps this one |
| `GET /api/v1/workspaces/:workspaceId` | | `{ workspace: Workspace, channels: Channel[] }`: the channels every member sees, and the person's own private ones |
| `PUT /api/v1/workspaces/:workspaceId` | `{ name }` | `Workspace`; `403` for a member who is not an owner |
| `POST /api/v1/workspaces/:workspaceId/channels` | `{ name, private? }` | `Channel`; a `private` one is the person's own. `409` if the name exists, also as another person's private channel |
| `PUT /api/v1/workspaces/:workspaceId/channels/:channelId` | `{ name }` | `Channel`, with the name as Golem keeps it: lowercase letters, also with diacritics, and numbers, with `-` between words. `409` if the name exists |
| `POST /api/v1/workspaces/:workspaceId/channels/:channelId/merge` | `{ into }` | `204`; its threads, files, artifacts, routines, suggestions, and source archives move to channel `into`, then the empty channel goes and the orchestrators move to the next channel that every member sees. Nobody deletes a channel otherwise. `403` when a channel that every member sees would merge into a private one; `409` while an agent of the channel works. Agents merge with `merge_channel` when a person asks |
| `GET /api/v1/workspaces/:workspaceId/facts` | | `{ text }`: facts that the family writes by hand, such as names, birthdays, and places; every agent of the workspace reads them; `""` until someone writes them |
| `PUT /api/v1/workspaces/:workspaceId/facts` | `{ text }` | `{ text }`; every member can write them; `400` over 20,000 characters |
| `GET /api/v1/workspaces/:workspaceId/members` | | `Member[]` |
| `POST /api/v1/workspaces/:workspaceId/members` | `{ email }` | `Member`; the person must have signed in once; `403` for a member who is not an owner |

### Threads (`src/threads/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/orchestrator` | | `ThreadSummary` of the person's own orchestrator in the workspace; the first call makes it |
| `GET /api/v1/workspaces/:workspaceId/threads?channel=&since=&before=&order=` | | `{ threads: ListedThread[] }`; all channel threads the person sees, including settled ones. All parameters are optional: `channel` is a name with or without `#`; `since` is inclusive and `before` exclusive, both filter last activity with an ISO 8601 date (UTC) or timestamp with a UTC offset; `order` is `newest` (default) or `oldest`. `400` for invalid dates, date ranges, or order; `404` for a channel the person does not see. Orchestrators are not channel threads |
| `POST /api/v1/workspaces/:workspaceId/threads` | `{ channelId, text }` | `ThreadSummary`; `text` becomes the first message, and its first line the title until the model names the topic in a few words |
| `GET /api/v1/threads/:threadId` | | `ThreadState` |
| `POST /api/v1/workspaces/:workspaceId/threads/:threadId/settled` | `{ settled: boolean }` | `ThreadSummary`; settled threads stay available in their channel, and any new message in one, such as a routine's answer, opens it again; `400` for the orchestrator |
| `POST /api/v1/workspaces/:workspaceId/threads/:threadId/channel` | `{ channelId }` | `ThreadSummary`; the thread moves to another channel that the person sees, with its artifacts, the files of its channel that no other thread there mentions, its routine, its open suggestions, and what Golem learned from it, and gets a note of who moved it. Only the person who started a thread moves it into their private channel. `400` for the orchestrator, `403` into a private channel for another person, `404` for a channel the person does not see, `409` while its agent works. Agents move a thread with `move_thread` when a person asks |
| `GET /api/v1/threads/:threadId/events` | | Server-sent events: `event: thread`, `data: ThreadState` after every change |
| `POST /api/v1/threads/:threadId/messages` | `{ text, voice?, requestId? }` | `204`; a retry with the same `requestId` sends nothing again |
| `POST /api/v1/threads/:threadId/approvals/:approvalId` | `{ allow: boolean, scope: "once" \| "turn" }` | `204`; `allow` runs the command once, or with `"turn"` also the rest of the turn's flagged commands on that machine. `403` for a person who is not the approver; `404` when the approval ended or the person is not a member |
| `POST /api/v1/threads/:threadId/live-activity` | `{ token, environment }` | `204`; a Live Activity of the iPhone, with this push token in hex and `"sandbox"` or `"production"`, follows the work for the person's newest message in the thread. Golem pushes an `ActivityState` when it changes, an alert while it waits for the person, and the end 5 seconds after the last thread of the work stops, which takes it away at once: the answer's notification tells how it went. A newer activity of the person for the thread ends the older one. |
| `POST /api/v1/threads/:threadId/stop` | | `204`; the agent drops the messages it has not read yet and ends its run. Threads it asked for something, and that still work on that message, stop too |
| `GET /api/v1/workspaces/:workspaceId/working` | | Server-sent events: `event: working`, `data: { threadIds: string[] }`, the threads whose agent works, at once and when work changes or a visible thread settles automatically. Load the workspace again on each event, also when `threadIds` stays empty |
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
in the first channel, but no `Channel.threads` list shows it, and it cannot be settled. Its memory keeps only its own
conversation, including the complete text and source link of each result that a worker sends back, even if Golem
answers `QUIET`. Worker reasoning,
tool calls, and other channel conversations stay out. `zoom` opens the original conversation messages and returned
results; `read_thread` and `recall` find other thread history when needed. On startup, the orchestrator restores its
context from this memory. The transcript keeps all original messages. See `src/threads/memory.ts`. The workspace's one
orchestrator from before each member had one belongs to the person who made the workspace.

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/learned` | | `{ learned: Learned[] }`: what Golem learned that the person sees, facts first |
| `PUT /api/v1/workspaces/:workspaceId/learned/:id` | `{ text }` | `Learned`; any person who sees an entry corrects it |
| `DELETE /api/v1/workspaces/:workspaceId/learned/:id` | | `204`; Golem does not learn it again |

After a thread with a person's new messages is quiet for 10 minutes, or settled, the model reviews those messages
(`src/threads/learned.ts`): it adds, changes, and removes facts about the people of the thread and the how-tos of its
channel, or of the person in their orchestrator. An entry from a private channel or an orchestrator belongs to that
person's realm. Every agent reads the entries that its realm sees before each answer, after the family's facts, and
the facts that people wrote win. The review can also suggest a routine or a reminder to a person who wrote in the
thread, when they asked for the same thing more than once or named a regular or later time: see Agenda. Reviews read
only messages after the first start of the version that has them.

Each channel has a brief, which the model writes again from the new messages of the channel's threads when they are
quiet for 10 minutes or settled, and the channel's summary with it. Every thread of the channel reads the brief and the
list of the channel's threads before each answer: see `src/threads/brief.ts`.

Agents call `list_threads` with the same optional `channel`, `since`, `before`, and `order` filters as the thread list
endpoint. Each result has the thread link, channel, last activity timestamp, and open or settled state. For example,
`list_threads({ since: "2026-11-03T12:00:00Z", order: "newest" })` lists activity since that time, newest first. A tool
uses the turn's realm, including the person whose message it answers in a shared channel.

Settling only cleans the UI. Settled threads remain in the search index, recall, channel briefs, and agent lists,
under the same access rules. The channel section of an agent's prompt lists the newest 30 other threads, including
settled ones; `list_threads`, `read_thread`, and `recall` give access to older threads.

Once every 24 hours, Golem settles the open channel threads with no activity for more than 14 days; no model reads
them. The existing five-minute background check starts the check when it is due, including after startup; the last
check time is saved in the workspace's memory database. Running threads, threads that wait for an approval,
orchestrators, and already settled threads stay as they are. Any new message in a settled thread, such as a
routine's answer, opens it again. This sends no notification. The thread and workspace event streams update the open screens on web and iOS. A person can reopen a
thread with the existing settled endpoint.

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

A notification goes to a person's inbox when the agent answers their message, when a channel thread reports back to a
thread they write in, for each answer of a reminder (to its recipient) that is not `QUIET`, for every failed
run of a routine (to its person, with the error, as a Golem message in its thread), and when an agent calls its `notify` tool, as it
does in a routine's run only when something is wrong or not usual. Other answers of a routine stay in its thread. An answer waits while threads that its agent asked still work for
it: the answer to their report notifies, or without one, this answer when they stop. While a screen of the person
follows the thread's events stream, its notifications are read at once and send no push; opening the stream reads the
thread's notifications before its first event, so load the inbox again then. Others go to the person's devices through
APNs, with the `Inbox.badge` and `workspaceId`, `channelId`, and `threadId` to open. Close the events stream when the
screen goes to the background. Pushes need `[apns]` in `config/golem.toml` and the key in `config/apns.p8`.

A push has buttons, on the iPhone and the Apple Watch, which work without opening the app and then read the notification
(`notificationId`). A push of a thread has the category `message`: Reply sends the text that the person types or
dictates, and Snooze sends the message "Remind me about this again in 15 minutes."; Done only reads it. It has
`mutable-content`, so the app shows it as a message from Golem in a conversation named after the thread, which Siri
reads aloud on AirPods and in CarPlay and answers with a spoken reply to the thread. A push of an approval has the
category `approval` and an `approvalId`: Deny and Allow answer it once. A reminder's answer and an approval are
`time-sensitive`, so they come through a Focus. A push that opens a channel has no buttons.

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
| `POST /api/v1/workspaces/:workspaceId/searches` | `{ query }` | `{ searches: RecentSearch[] }`; the apps save a query when the person presses Enter or opens a result, or when its results rest a second |

### Integrations (`src/integrations/`)

`…` is `/api/v1/workspaces/:workspaceId`.

| Request | Body | Response |
| --- | --- | --- |
| `GET …/integrations` | | `Integration[]`, with the person's own credentials and the ones other members shared |
| `POST …/integrations/:integrationId/credentials` | `{ label?, secret, address?, username? }`; `label` when the integration is `labeled`, `address` when it has `address`, `username` when it has `username` | `Credential`, private; `400` unless `connect` is `"secret"`, or when the integration cannot use the secret, such as a Slack cURL whose session Slack refuses |
| `POST …/integrations/:integrationId/connect` | `{ phone }` for `"phone"`; `{ address }` for `"sign-in"` with `address`: the person's own server | `{ url }`: the integration's sign-in page; `{ code }` for `"phone"`. `400` when `address` is not http or https |
| `POST …/integrations/:integrationId/sign-in` | `{ address }`; `{}` for `"phone"` | `Credential`, private; `400` when the address is not of the person's own sign-in in this workspace, the sign-in did not finish, or the number did not link within a minute |
| `PUT …/credentials/:credentialId` | `{ shared }`, `{ watched }`, or both | `Credential`; `404` unless it is the person's own; `400` for `watched: true` when the integration is not `watchable` |
| `DELETE …/credentials/:credentialId` | | `204`; `404` unless it is the person's own |
| `PUT /api/v1/integrations/:integrationId/client` | `{ clientId, clientSecret }` | `204`; the next sign-in uses it, at once. `403` unless the person is the server's owner, `404` unless the integration has `client`, `400` with the reason when the integration's API refuses the client, such as Tesla's when it cannot register Golem's domain |
| `GET /.well-known/appspecific/com.tesla.3p.public-key.pem` | | The public key that Tesla's Fleet API checks Golem's signed commands with, with no sign-in; `404` without the Tesla integration |

A person connects integrations in Settings. A new credential is private: only the turns of its owner use it. Its owner
shares it, and then the turns of every member use it, or makes it private again; only its owner deletes it. A turn is
for the author of the message it answers, the person whose request another thread passes on, the person who last
wrote a routine's instructions or script, or the person who asked for a reminder or last changed it. Each tool call
uses the newest credential of that person, else the newest shared one, unless the call names another account in its
`account` argument; `<integrationId>_accounts` lists them. The agents of a workspace get the tools of each integration
that someone connected there. Secrets never leave the server.

An integration with `connect: "sign-in"` is one or more MCP servers, such as Rohlík's or Plaud's, or an API that
Golem's own tools call, such as Google's. With `address`, such as T3 Code, the MCP server runs on the person's own
machine: the app asks for its address before `connect`, and the credential, labeled with its host, keeps it. The app shows a link to the `url` of `connect`; the person signs in there. Rohlík lets self-registered clients return only to
loopback addresses, so the sign-in ends on an error page at
`https://localhost/golem-sign-in?code=…&state=…`. The person pastes that address, and `sign-in` keeps the tokens as a
credential, labeled with the account's email when the server gives it. The agents then get the servers' tools as
`<integrationId>_<tool>`, in the codemode namespace of the integration. Golem lists a server's tools with the newest
shared sign-in, else with a private one; the list has only tool names and schemas. Google's tools run gog with
an access token that Golem renews with the refresh token.

An integration with `client` signs in with Golem's own OAuth client, because its sign-in server does not register
clients: Google, Netatmo, and Tesla. The server's owner sets the client in Settings; until then, only the owner sees
the integration, and `connect` answers `400`. Tesla registers Golem's domain with the client before Golem keeps it.
`docs/integrations.md` shows how to make the clients.

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

Every new run starts a new active context in the same Pi Durable conversation. Its full transcript stays visible.
The run saves its definition and initial script store, then its script result, for recovery. During a run,
`routines_test_script` reads that run's proposed store so the agent can read current source records; only a successful
run commits it for the next scan. Completed run inputs and results stay stored. Long runs compact between tool rounds
at 160 KiB of serialized input. A provider guard refuses routine input above 256 KiB; neither limit is an exact token
count. A reminder keeps its existing conversation context.

A routine at a place has a place, `arrive` or `leave`, and a person in place of a schedule. The place must be one that
the person and the writer of the routine both use, and the person must see its channel. It runs each time the person
crosses the circle for its event, at most every 15 minutes, and not for a crossing that Golem hears of more than 15
minutes late. A new routine waits for the next crossing. A removed place keeps its routines.

### One-time reminders (`src/reminders/`)

Agents in every thread of a workspace, including its orchestrator, have `reminders_create`, `reminders_places`,
`reminders_list`, `reminders_update`, and `reminders_cancel`. A reminder belongs to that workspace and its source thread. It runs once when
its saved UTC time is due, or when Golem starts again after that time. Its turn is for the person who asked for it or
last changed it, not for its recipient; a reminder from before this rule uses only the shared credentials.
Agents make and change reminders; a person sees their pending ones in Upcoming and cancels one there.

A reminder at a place has a place and `arrive` or `leave` in place of a time. The place must be one that its recipient
and the person who asks both use. It is due once the recipient crosses the circle for its event after it was made, also
when Golem hears of it late. A new reminder starts as outside: one for an arrival where the recipient is now is due at
once. A reminder at a place can have a window: `from` (not before, such as "when I get to work on Monday"; for an
arrival where the recipient already is then, it fires then) and `until` (when its event has not come by then, it fires
then anyway, so a reminder is never lost). "At 18:00 if I am home, else when I get home" is arrive home from 18:00.

### Intake (`src/intake/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/intake?q=words` | | `{ evidence, checks, coverage }`, scoped to the signed-in person; evidence contains up to 30 current source records |

Evidence has `id`, `conversation` (source account and conversation), `text`, `at` (Unix milliseconds), `source`,
`url`, and `fromOwner`, with optional `bulk` and attachment name, type, and size metadata. A check has `id`, `threadId`,
`text`, `sourceIds`, `checkAt`, `deadlineAt`, `reviewAt`, and `notifiedAt`. A null `deadlineAt` means an internal review,
not a promised deadline. Coverage has `source` (credential id), `through` (Unix milliseconds), and `error`.
All workspace access requires membership. Turning off an account stops its source reads and automatic checks and
notices. Existing audit records remain private. Deleted Golem threads are excluded from source recall.

"Read for me" is off by default and only its credential owner can change it. It permits automatic private context,
future checks, and useful source reviews in the existing subject thread. Matching shared family threads may receive
the source material. External messages still need the person's request and normal tool approval. Collection runs every 15 minutes, starts one day back, and uses saved cursors with an overlap. A bounded
poll can retain a backlog checkpoint without claiming complete source coverage.

Personally relevant Slack messages, Primary inbox mail after Gmail filters plus sent-mail context, and both directions of WhatsApp are grouped into bounded batches. Related source history and subject checks reach the
configured model provider. Golem validates source ids, exact supporting quotes, destinations, and time fields before
it changes state. Each subject gets its own decision. Current source versions are searchable; older versions remain
as historical evidence. Full source and decision records live in the private audit database.

Future checks run from durable times, even without new messages. Before a no-reply decision, Golem checks source
coverage and related replies. Passive filing starts no thread turn. Useful thread reviews can run silently. A useful development is posted
in its existing subject thread, as a visible Golem message with attached source files; no agent starts on it, and
the thread's agent works only when a person asks there.
When no thread matches a useful development, Golem starts a subject thread in one of the person's own private
channels. If none fits, Golem creates a private channel and its first thread. Invitations and tickets can start these threads.
Channel names cover lasting subjects; thread titles name specific matters. The normal agent can search connected
accounts for older related sources. No background worker thread is made. Nonurgent developments wait for the person's morning
review in the 08:00 Europe/Prague hour: one plan groups them by matter, drops what is handled or stale, posts one
message to each thread with what it asks of the person, nudges each open ask every 2 days in the morning summary, and
sends one summary to the person's own thread with a notification (see `docs/proactive.md`). One urgent delivery group belongs to one person and one subject thread. Stable request ids
prevent duplicate review messages, runs, and notices. A resolved check cancels queued reviews. A `QUIET` answer sends
no notice and does not mark an internal check as already notified. The judge separately proposes a notification with
an exact source quote and one reason: the owner requested it, a substantive awaited reply needs attention, a stated
time arrived, or time-sensitive preparation helps now. A new message, mention, or hour without a reply is insufficient.
Only a proposed notification triggers a fresh read of its source accounts and a final judge check after the thread
answers. A later owner reply can suppress the notice while the useful answer remains visible. Source failures keep
the notification pending for retry. Silent turns cannot promote themselves with `notify` or a useful answer. A morning
review cannot promote a silent update either; its one summary notification is the person's. Only confirmed notifications mark their related due checks as notified.
Automatic reviews use the normal tools of the
thread, including connected accounts, with the same person, access rules, and approvals as a normal turn. Tool calls,
results, and errors remain in the private audit log. Source inputs and files use the existing message endpoints and
event streams on web and iOS.

A turn uses the script tools for the person it answers, in any thread: `intake_read({ query })` and `intake_update({ id, action, revision, quote })`. `intake_read` gives the observations that match the query, every waiting update with its destination, time, and source names, and the checks; reading it changes nothing. The latter
requires an exact quote from the person's latest message. Source text is untrusted data. See [process](proactive.md).

#### Following

Both apps show in **Following** all that intake holds for the signed-in person: the thread updates that wait, the
open checks, the sources with how far Golem read them, what it keeps and where each observation went, the updates and
checks of the last week that are done, and the person's feedback. Each row opens its detail.

| Endpoint | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/following/overview?q=` | | `FollowingOverview`; `q` searches what intake keeps, else the 100 newest observations |
| `POST /api/v1/workspaces/:workspaceId/following/updates/:updateId` | `{ action: "now" \| "cancel" }` | The `IntakeUpdate`; `now` posts a waiting update at the next minute, before the 08:00 review, even if the destination check would wait; `cancel` drops it. `409` once it was posted or cancelled; `404` for an update outside the person's visible threads and sources |
| `DELETE /api/v1/workspaces/:workspaceId/following/updates/:updateId` | | `204`; deletes a waiting update and blocks what it came from: the sender's address of each observation that the person did not write, in all their accounts, or the chat of a group or a document. Every observation of a blocked sender or chat is deleted, the files that hold one are written again without it or deleted when nothing is left, the waiting updates that rest on one are cancelled, and the checks that rest only on them are deleted. Intake keeps later messages of a blocked sender or chat as deleted and never assesses them. `409` once it was posted or cancelled |
| `DELETE /api/v1/workspaces/:workspaceId/following/blocks/:blockId` | | `204`; intake reads the sender or chat again; what it deleted stays deleted |
| `POST /api/v1/workspaces/:workspaceId/following/feedback` | `{ target: "item:<id>" \| "update:<id>" \| "source:<credentialId>", quote: string }` | The `IntakeFeedback`; every later assessment reads the 30 newest as the owner's corrections. `404` for a target the person cannot see |
| `GET /api/v1/workspaces/:workspaceId/following` | | `{ checks: FollowingCheck[] }`, including open, resolved, and stopped checks |
| `GET /api/v1/workspaces/:workspaceId/following/:checkId` | | `{ check, evidence, history }`; all supporting source text, even outside the latest 30 observations; newest revision first |
| `POST /api/v1/workspaces/:workspaceId/following/:checkId` | `{ action: "handled" \| "stop" \| "reopen" \| "correct" \| "undo", revision: number, quote: string }` | The updated detail; `409` if the check changed; `404` for a check outside the person's visible sources and threads |

```ts
type CheckSnapshot = {
  text: string; state: "open" | "resolved" | "stopped";
  sourceIds: string[]; threadId: string | null;
  checkAt: number; reviewAt: number; explicitTime: number; notifiedAt: number | null;
};
type FollowingCheck = CheckSnapshot & { id: string; revision: number; updatedAt: number };
type CheckRevision = { id: number; at: number; action: string; quote: string | null; previous: CheckSnapshot | null; current: CheckSnapshot };
type IntakeEvidence = { id: string; source: string; text: string; at: number; url: string | null; fromOwner: boolean; attachments?: { name: string; type: string; size: number }[] };
type FollowingOverview = {
  sources: { id: string; name: string; readAt: number | null; error: string | null; kept: number }[];
  updates: IntakeUpdate[]; // waiting ones, and those of the last week; newest first
  kept: (IntakeEvidence & { outcome: "thread" | "filed" | "context"; threadId: string | null; place: string | null })[];
  feedback: IntakeFeedback[];
  blocked: { id: string; kind: "sender" | "chat"; label: string; createdAt: number }[]; // newest first
};
type IntakeUpdate = {
  id: string; threadId: string | null; threadTitle: string | null; newThread: string | null; // the title of a thread Golem will start
  body: string; attention: "now" | "brief"; notice: string | null; // why Golem will also notify
  createdAt: number; deliveredAt: number | null; cancelledAt: number | null; evidence: IntakeEvidence[];
};
type IntakeFeedback = { id: string; target: string; about: string; quote: string; createdAt: number };
```

`quote` is the person's exact correction, at most 8000 characters. `correct` uses the intake model to change only the selected matter. A partial answer preserves the remaining question. `stop` stops monitoring without declaring resolution. `undo` restores the previous revision. Changes cancel queued updates for that check and retain the before and after states in the audit. No action creates a thread. The ledger remains private even if the linked discussion is shared. Stated dates (`explicitTime = 1`, `checkAt`) are separate from internal reviews (`reviewAt`). Both apps refresh this view every 30 seconds while it is open; no existing stream publishes check changes.


### Agenda (`src/agenda/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/upcoming` | | `Upcoming`: what Golem runs for the person and what waits for them |
| `POST /api/v1/workspaces/:workspaceId/suggestions/:suggestionId` | `{ accept: boolean }` | `204`; `accept` makes the routine in its channel, the reminder in the person's orchestrator, or the person's private channel, all as theirs; else Golem does not suggest it again. `404` for another person's suggestion; `409` when its channel is gone or its time has passed |
| `GET /api/v1/workspaces/:workspaceId/watched-places` | | `{ places: WatchedPlace[] }`: the places that the person's iPhone watches, those of their pending reminders and enabled routines at a place |
| `POST /api/v1/workspaces/:workspaceId/watched-places/:placeId/reports` | `{ event: "arrive" \| "leave", at, initial }` | `204`; the iPhone saw the person arrive or leave at `at` (Unix milliseconds; a time in the future is now). `initial`: the first state after it started to watch the place, which is no crossing. A report older than the last one, or of the same state, changes nothing. `400` for another body; `404` unless the person's iPhone watches the place |
| `DELETE /api/v1/workspaces/:workspaceId/reminders/:reminderId` | | `204`; cancels a pending reminder for the person or from them; `404` for another one; `409` while it runs or after it was delivered |

The iPhone watches the places of `watched-places` with Core Location and tells Golem only what it sees there, never
where the person is. Golem keeps only each person's last state at each place, and decides what is due: a crossing
makes due the reminders and runs the routines of its event. The first state after the iPhone starts to watch a place
makes due only the reminders for an arrival, as a reminder starts as outside. The iPhone gets a new place when the app
opens or goes to the background.

Golem suggests and never makes an automation or a channel itself: a suggestion waits, with no push, until its person
accepts or declines it. A person has at most 3 waiting; Golem drops one with the same name as one they already had, and one whose
schedule or time cannot run.

### Places (`src/places/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/places` | | `{ places: Place[] }`: the person's own places, then the ones other members shared, by name |
| `POST /api/v1/workspaces/:workspaceId/places` | `{ name, latitude, longitude, radius, shared }` | `201` `Place`; `400` without a pin, a name, or a radius of 100 to 5000 m; `409` when the person has a place with that name |
| `PUT /api/v1/workspaces/:workspaceId/places/:placeId` | `{ name, latitude, longitude, radius, shared }` | `Place`; `404` unless the person added it |
| `DELETE /api/v1/workspaces/:workspaceId/places/:placeId` | | `204`; `404` unless the person added it. Its pending reminders keep it |
| `GET /api/v1/map/search?q=<address>` | | `{ latitude, longitude, label }`: the first place that OpenStreetMap's search finds, which the web app's map moves to; `404` when it finds none. The iOS app searches with Apple Maps |
| `GET /api/v1/map/:zoom/:x/:y` | | An OpenStreetMap tile as PNG, which the web app's map shows; Golem gets it, because the page loads pictures only from Golem |

A person adds places in Settings, from a pin in the middle of a map, which an address moves to. Like a machine, a new place is private to its owner's turns until
they share it.

### Phone (`src/phone/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/phone/calls` | | Server-sent events: `event: call`, `data: { id, workspaceId, name, arguments }`, a call of an agent's `phone_<name>` tool for the person's phone |
| `POST /api/v1/phone/calls/:callId` | `{ text }` or `{ error }`; as `multipart/form-data`, also `files`: JPEG pictures | `204`; the tool returns the text and the pictures, or fails with the error. `404` unless the call went to the person and still waits |

Only the iOS app opens the stream, while it is open: a turn's phone tools act on the phone of the turn's person,
and fail when no stream of that person is open. A call goes to the stream that the person opened last, and waits 3
minutes for its answer; it fails when that stream closes first.

### Feedback (`src/feedback/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/feedback` | | `{ feedback: Feedback[] }`: the reports that nobody dismissed, newest first. `403` for a person who is not the server's owner |
| `DELETE /api/v1/workspaces/:workspaceId/feedback/:feedbackId` | | `204`; dismisses the report. `403` for a person who is not the server's owner; `404` for a dismissed one |

Agents in every thread have `feedback_report`: when a tool fails or answers wrong, when no tool can do what the work
needs, or when they see an easier way, they report it once and continue. A report keeps its thread and the person of
its turn. The server's owner reads every report, also those from another person's private turns, without the link to
a thread they do not see; the agent describes Golem, not the person.

### Machines (`src/hands/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/workspaces/:workspaceId/machines` | | `{ machines: Machine[], pairing: Pairing \| null }`: the person's own machines and the ones other members shared; poll it while `pairing` is set to see the machine arrive |
| `POST /api/v1/workspaces/:workspaceId/machines/pairing` | | `Pairing`; replaces the person's earlier pairing. `409` when `base_url` is not `https://` or Golem has no hands binaries |
| `PUT /api/v1/workspaces/:workspaceId/machines/:machineId` | `{ shared }` | `Machine`; `404` unless the person paired it |
| `DELETE /api/v1/workspaces/:workspaceId/machines/:machineId` | | `204`; `404` unless the person paired it |

A person pairs machines in Settings. A new machine is private: only the turns of the person who paired it use it. That
person shares it, and then the turns of every member use it, or makes it private again. Several people can pair one
machine: it trusts each person's key, and a turn of one of them shows it once, as their own.

The machine calls these, without an account; the 16-character pairing code in the path is the credential. They follow
the contract of `hands/docs/pairing.md`, with Golem in the phone's place.

| Request | Response |
| --- | --- |
| `GET /hands/:code` | `hands/scripts/pair-install.sh`, with Golem's address, the pin of its TLS key, and the binaries' SHA-256 |
| `GET /hands/:code/hands-<os>-<arch>` | A binary from `hands/dist/`, which `hands/scripts/build-release.sh` builds |
| `POST /hands/:code/pair` | `{ phoneName, publicKey }`: `Golem · <name>` of the person who paired it, and their Ed25519 key. `400` on a malformed request, also for a loopback or link-local address or a `localhost` name, `404` once the code was used, `410` once it expired |

### LLM (`src/llm/`)

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/llm` | | `Llm` |
| `POST /api/v1/llm/login` | | `Llm` with `login` set; open `verificationUri` and enter `userCode` |
| `POST /api/v1/llm/logout` | | `Llm` |
| `PUT /api/v1/llm/model` | `{ model }` | `Llm` |
| `PUT /api/v1/llm/effort` | `{ effort }` | `Llm`; `400` when the model does not support it |
| `GET /api/v1/workspaces/:workspaceId/usage?days=30` | | `Usage` of the last `days` days, 1 to 366 |

Only the server's owner, the first email in `allowed_emails`, logs in, logs out, and chooses the model and the effort;
these routes answer `403` to other people. Usage is each person's own; the owner sees everyone's, and each person's
share. Each run counts once, at its end, for the person of its message.

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
  reads. Its tools, recall, routines, and reminders follow this rule; notifications follow the thread. An orchestrator
  remembers only its own conversation and the results sent back to it. A thread of a channel may still report back to the
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
- A machine belongs to the person who paired it. While it is private, only that person's turns use it; once they share
  it, every agent in the workspace can use it, whoever the agent works for. The machine trusts the key of that person,
  so pairing it with one Golem does not open it to another. A command on a machine that
  [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) flags, such as `rm -rf` or
  `git reset --hard`, waits for an approval (`ThreadState.approvals`, with a notification) from the member who paired
  the machine when the turn is another person's, and from the turn's person otherwise; a command that dcg cannot judge
  waits too. Other commands, file reads, and file writes run at once.
- A connector tool that acts as a person, such as `google_mail_send`, `google_mail_send_draft`, `slack_send`,
  `whatsapp_send`, `whatsapp_send_file`, or a `google_calendar_*_event` call with `notify`, waits for an approval before every call, which shows what it sends: from the person who added the credential that it uses while
  they are a member, else from the turn's person. `"turn"` allows only that call. A routine's script cannot call it.
- Agents reach public addresses only: the browser and `save_file` go through Golem's egress proxy, which refuses
  loopback, private, link-local, and other non-public addresses after each DNS answer and redirect. Each person of a
  thread has a browser of their own, with their own logins.
- A codemode script stops after 15 minutes. A routine runs at most every 15 minutes.
- A credential belongs to the person who connected it. While it is private, only that person's turns use it; once they
  share it, the turns of every member use it. A turn never uses another person's private credential. Secrets never
  leave the server.
