package dev.golem.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// The models mirror the TypeScript types in docs/api.md. Times are Unix milliseconds.

@Serializable
data class User(val id: String, val name: String, val email: String, val picture: String? = null)

@Serializable
data class Workspace(val id: String, val name: String, val role: String)

@Serializable
data class Profile(val user: User, val workspaces: List<Workspace>, val owner: Boolean = false)

@Serializable
data class ThreadSummary(
    val id: String,
    val channelId: String,
    val title: String,
    val updatedAt: Double,
    val settledAt: Double? = null,
)

@Serializable
data class Channel(
    val id: String,
    val name: String,
    /** The person a private channel belongs to, who alone sees it; null for a channel every member sees. */
    val ownerId: String? = null,
    val summary: String? = null,
    /** One emoji, shown in place of the # before the name. */
    val icon: String? = null,
    val threads: List<ThreadSummary> = emptyList(),
)

@Serializable
data class WorkspaceDetail(val workspace: Workspace, val channels: List<Channel>)

@Serializable
data class Member(
    val userId: String,
    val name: String,
    val email: String,
    val picture: String? = null,
    val role: String,
)

@Serializable
data class Facts(val text: String)

@Serializable
data class Message(
    val id: String,
    val authorId: String? = null,
    val author: String,
    val agent: Boolean,
    val text: String,
    val time: Double,
    val failed: Boolean = false,
    val streaming: Boolean = false,
    val files: List<FileRef> = emptyList(),
    /** What the agent did before this answer; null for people and for an answer without work. */
    val work: Work? = null,
)

/** The agent's work before an answer. `endedAt` is null while it works. */
@Serializable
data class Work(
    val startedAt: Double,
    val endedAt: Double? = null,
    val stopped: Boolean = false,
    val steps: List<Step> = emptyList(),
)

/** A thought, words between tool calls, or a tool call. */
@Serializable
data class Step(
    val kind: String,
    val text: String,
    val tool: String? = null,
    val input: String? = null,
    val output: String? = null,
    val running: Boolean = false,
    val failed: Boolean = false,
)

@Serializable
data class WorkingThreads(val threadIds: List<String>)

/** Something that needs the person: it opens its thread, or its channel without one. */
@Serializable
data class InboxNotification(
    val id: String,
    val workspaceId: String,
    val channelId: String,
    val threadId: String? = null,
    val title: String,
    val text: String,
    val createdAt: Double,
    val readAt: Double? = null,
)

@Serializable
data class Inbox(val notifications: List<InboxNotification>, val unread: Int, val badge: Int)

@Serializable
data class FileRef(val id: String, val name: String)

/** A file of a channel, or of the workspace for the orchestrator. */
@Serializable
data class SavedFile(val id: String, val name: String, val size: Double, val time: Double) {
    val ref get() = FileRef(id, name)
}

@Serializable
data class SavedFiles(val files: List<SavedFile>)

@Serializable
data class ThreadState(
    val thread: ThreadSummary,
    val messages: List<Message>,
    val running: Boolean,
    val approvals: List<Approval> = emptyList(),
)

/** An action the agent waits for one person to allow, or for any member when `approverId` is null. */
@Serializable
data class Approval(
    val id: String,
    val tool: String,
    val text: String,
    val approverId: String? = null,
    /** Whether the person may also allow the rest of the turn on its machine. */
    val allowsTurn: Boolean = false,
    val expiresAt: Double,
)

/** A page or small app an agent made; it belongs to a channel, or to the workspace when `channelId` is null. */
@Serializable
data class Artifact(
    val id: String,
    val channelId: String? = null,
    val threadId: String,
    val title: String,
    val visibility: String,
    val url: String,
    val visitors: Int = 0,
    val createdAt: Double,
    val updatedAt: Double,
)

@Serializable
data class ArtifactList(val artifacts: List<Artifact>)

/** A value an artifact keeps: shared (`visitor` is null), or owned by one visitor. */
@Serializable
data class ArtifactRecord(
    val id: String,
    val visitor: String? = null,
    val name: String? = null,
    val key: String,
    val value: JsonElement,
    val updatedAt: Double,
)

@Serializable
data class ArtifactDetail(val artifact: Artifact, val records: List<ArtifactRecord>, val content: String)

@Serializable
data class SearchResult(
    val uri: String,
    val kind: String,
    val title: String,
    val threadId: String? = null,
    val channelId: String? = null,
    val snippet: String = "",
    val score: Double = 0.0,
    val updatedAt: Double = 0.0,
)

@Serializable
data class SearchResponse(val results: List<SearchResult>, val semantic: Boolean = true)

@Serializable
data class RecentSearch(val query: String, val searchedAt: Double)

@Serializable
data class RecentSearches(val searches: List<RecentSearch>)

/** What a channel is for and where it is now, as Markdown with thread links. */
@Serializable
data class Brief(val text: String, val updatedAt: Double)

@Serializable
data class ChannelBrief(val brief: Brief? = null)

@Serializable
data class TokenResponse(val token: String? = null)

@Serializable
data class ConnectPage(val url: String? = null, val code: String? = null)
