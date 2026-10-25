# Golem API

The web app and the iOS app have the same functionality. The web app renders HTML on the server with Datastar; the
iOS app uses this JSON API. Both call the same server code.

## Authentication

Accounts are managed by [better-auth](https://www.better-auth.com). Native clients use bearer tokens.

| Request | Body | Response |
| --- | --- | --- |
| `POST /api/auth/sign-up/email` | `{ name, email, password }` | `{ token, user }`, header `set-auth-token` |
| `POST /api/auth/sign-in/email` | `{ email, password }` | `{ token, user }`, header `set-auth-token` |
| `POST /api/auth/sign-out` | none | `{ success }` |

Send `Authorization: Bearer <token>` on every `/api/v1` request. A `401` response means the token is missing or expired.

Sign-up is open while the server has no users. After that, only addresses in `GOLEM_ALLOWED_EMAILS` can sign up.

## Types

```ts
type User = { id: string; name: string; email: string };
type Workspace = { id: string; name: string };
type ThreadSummary = { id: string; channelId: string; title: string; updatedAt: number }; // times are Unix milliseconds
type Channel = { id: string; name: string; threads: ThreadSummary[] }; // threads newest first
type Message = {
	id: string;
	authorId: string | null; // null for the agent
	author: string; // display name, "Golem" for the agent
	agent: boolean;
	text: string;
	time: number;
	failed: boolean; // the agent's answer failed; text is the error
	streaming: boolean; // the agent is still writing this message
};
type ThreadState = { thread: ThreadSummary; messages: Message[]; running: boolean };
type Member = { userId: string; name: string; email: string; role: "owner" | "admin" | "member" };
type Credential = { id: string; label: string; shared: boolean; mine: boolean; ownerName: string; createdAt: number };
type Integration = { id: string; name: string; secretLabel: string; enabled: boolean; credentials: Credential[] };
type Llm = {
	connected: boolean;
	provider: string; // "ChatGPT"
	model: string;
	models: string[];
	login: { userCode: string; verificationUri: string; expiresAt: number } | null; // set while a device login waits
	error: string | null; // the last login error
};
```

## Endpoints

Workspace paths answer `404` to users who are not members of the workspace.

| Request | Body | Response |
| --- | --- | --- |
| `GET /api/v1/me` | | `{ user: User, workspaces: Workspace[] }` |
| `POST /api/v1/workspaces` | `{ name }` | `Workspace`; the creator becomes owner, and the workspace gets a `general` channel |
| `GET /api/v1/workspaces/:workspaceId` | | `{ workspace: Workspace, channels: Channel[] }` |
| `POST /api/v1/workspaces/:workspaceId/channels` | `{ name }` | `Channel`; `409` if the name exists |
| `POST /api/v1/workspaces/:workspaceId/threads` | `{ channelId, text }` | `ThreadSummary`; `text` becomes the first message and the title |
| `GET /api/v1/threads/:threadId` | | `ThreadState` |
| `GET /api/v1/threads/:threadId/events` | | Server-sent events: `event: thread`, `data: ThreadState` after every change |
| `POST /api/v1/threads/:threadId/messages` | `{ text }` | `204` |
| `GET /api/v1/workspaces/:workspaceId/members` | | `Member[]` |
| `POST /api/v1/workspaces/:workspaceId/members` | `{ email }` | `Member`; the person must already have an account |
| `GET /api/v1/workspaces/:workspaceId/integrations` | | `Integration[]` for the current user |
| `PUT /api/v1/workspaces/:workspaceId/integrations/:integrationId` | `{ enabled }` | `Integration` |
| `POST /api/v1/workspaces/:workspaceId/integrations/:integrationId/credentials` | `{ label, secret, shared }` | `Credential` |
| `DELETE /api/v1/workspaces/:workspaceId/credentials/:credentialId` | | `204`; only the owner can delete |
| `GET /api/v1/llm` | | `Llm` |
| `POST /api/v1/llm/login` | | `Llm` with `login` set; open `verificationUri` and enter `userCode` |
| `POST /api/v1/llm/logout` | | `Llm` |
| `PUT /api/v1/llm/model` | `{ model }` | `Llm` |

Errors other than `401`, `204`, and `404` have the body `{ error: string }`.

## Isolation

- Workspaces share nothing except the LLM provider, which the server owner connects once in `/settings`.
- Each thread is one Pi Durable session in its own SQLite file under its workspace's directory.
- Integration settings belong to one user in one workspace. A credential is private to its owner, or shared with
  every agent in the workspace when `shared` is true. Secrets never leave the server.
