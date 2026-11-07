package dev.golem.api

import kotlinx.serialization.Serializable

// All that intake holds for the person (docs/api.md, Following).

@Serializable
data class FollowingCheck(
    val id: String,
    val revision: Int,
    val text: String,
    /** "open", "resolved", or "stopped". */
    val state: String,
    val threadId: String? = null,
    val checkAt: Double,
    val reviewAt: Double,
    /** 1 when `checkAt` is a time that a person stated. */
    val explicitTime: Int = 0,
    val updatedAt: Double,
) {
    val stateLabel get() = when (state) {
        "resolved" -> "Handled"
        "stopped" -> "Stopped"
        else -> "Following"
    }
}

@Serializable
data class FollowingDetail(
    val check: FollowingCheck,
    val evidence: List<FollowingEvidence> = emptyList(),
    /** Newest first. */
    val history: List<FollowingRevision> = emptyList(),
)

@Serializable
data class FollowingAttachment(val name: String)

@Serializable
data class FollowingEvidence(
    val id: String,
    val source: String,
    val text: String,
    val at: Double,
    val url: String? = null,
    val fromOwner: Boolean = false,
    val attachments: List<FollowingAttachment> = emptyList(),
) {
    /** "Mail (a@b.c); Balcony; Alice" reads as "Alice · Balcony". */
    val name get() = sourceName(source)
}

/** "Mail (a@b.c); Balcony; Alice" reads as "Alice · Balcony". */
fun sourceName(source: String): String {
    val parts = source.split("; ")
    val name = listOf(parts.getOrElse(2) { "" }, parts.getOrElse(1) { "" }).filter { it.isNotEmpty() }
    return if (name.isEmpty()) source else name.joinToString(" · ")
}

@Serializable
data class FollowingSnapshot(val text: String, val state: String, val checkAt: Double, val explicitTime: Int = 0)

@Serializable
data class FollowingRevision(
    val id: Int,
    val at: Double,
    val action: String,
    val quote: String? = null,
    val previous: FollowingSnapshot? = null,
    val current: FollowingSnapshot,
)

/** All that intake holds for the person: its sources, its thread updates, what it keeps, and the person's feedback. */
@Serializable
data class FollowingOverview(
    val sources: List<IntakeSource> = emptyList(),
    val updates: List<IntakeUpdate> = emptyList(),
    val kept: List<IntakeKept> = emptyList(),
    val feedback: List<IntakeFeedback> = emptyList(),
    val blocked: List<IntakeBlock> = emptyList(),
)

/** A sender ("sender"), or a group chat ("chat"), whose messages Golem never reads again. */
@Serializable
data class IntakeBlock(val id: String, val kind: String, val label: String, val createdAt: Double)

@Serializable
data class IntakeSource(
    val id: String,
    val name: String,
    val readAt: Double? = null,
    val error: String? = null,
    val kept: Int = 0,
)

@Serializable
data class IntakeUpdate(
    val id: String,
    val threadId: String? = null,
    val threadTitle: String? = null,
    /** The title of a thread Golem will start. */
    val newThread: String? = null,
    val body: String,
    /** "now" or "brief". */
    val attention: String,
    /** Why Golem will also notify. */
    val notice: String? = null,
    val createdAt: Double,
    val deliveredAt: Double? = null,
    val cancelledAt: Double? = null,
    val evidence: List<FollowingEvidence> = emptyList(),
) {
    val waits get() = deliveredAt == null && cancelledAt == null
    val title get() = threadTitle ?: "New thread: ${newThread ?: "untitled"}"

    /** The message, without the source links after it. */
    val message get() = body.lastIndexOf("\n\n").let { if (it < 0) body else body.substring(0, it) }
}

@Serializable
data class IntakeKept(
    val id: String,
    val source: String,
    val text: String,
    val at: Double,
    val url: String? = null,
    val fromOwner: Boolean = false,
    val attachments: List<FollowingAttachment> = emptyList(),
    /** "thread", "filed", or "context". */
    val outcome: String,
    val threadId: String? = null,
    val place: String? = null,
) {
    val name get() = sourceName(source)

    val badge get() = when (outcome) {
        "thread" -> "In thread"
        "filed" -> "Filed"
        else -> "Context"
    }

    /** Where the observation went: its thread, its channel's files, or only Golem's context. */
    val location get() = when (outcome) {
        "thread" -> "In ${place ?: "a thread"}"
        "filed" -> "Filed in ${place ?: "a channel"}"
        else -> "Kept as context"
    }
}

@Serializable
data class IntakeFeedback(val id: String, val target: String, val about: String = "", val quote: String, val createdAt: Double)

@Serializable
private data class FollowingList(val checks: List<FollowingCheck>)

suspend fun Api.following(workspaceId: String): List<FollowingCheck> =
    get<FollowingList>("/api/v1/workspaces/$workspaceId/following").checks

suspend fun Api.followingDetail(workspaceId: String, checkId: String): FollowingDetail =
    get("/api/v1/workspaces/$workspaceId/following/$checkId")

suspend fun Api.followingOverview(workspaceId: String, query: String): FollowingOverview =
    get(url("/api/v1/workspaces/$workspaceId/following/overview").newBuilder().addQueryParameter("q", query).build())

/** `action` "now" posts a waiting update at the next minute; "cancel" drops it. */
suspend fun Api.changeUpdate(workspaceId: String, updateId: String, action: String): IntakeUpdate =
    post("/api/v1/workspaces/$workspaceId/following/updates/$updateId", Api.body("action" to action))

/** Deletes a waiting update and blocks its senders, or its group chat: Golem deletes what it read from them. */
suspend fun Api.deleteUpdate(workspaceId: String, updateId: String) {
    send("DELETE", "/api/v1/workspaces/$workspaceId/following/updates/$updateId")
}

/** Lets Golem read a blocked sender or chat again. */
suspend fun Api.unblock(workspaceId: String, blockId: String) {
    send("DELETE", "/api/v1/workspaces/$workspaceId/following/blocks/$blockId")
}

suspend fun Api.sendFeedback(workspaceId: String, target: String, quote: String): IntakeFeedback =
    post("/api/v1/workspaces/$workspaceId/following/feedback", Api.body("target" to target, "quote" to quote))

/** `action`: "handled", "stop", "reopen", "correct", or "undo"; `409` when the check changed since `check.revision`. */
suspend fun Api.changeFollowing(workspaceId: String, check: FollowingCheck, action: String, quote: String): FollowingDetail =
    post(
        "/api/v1/workspaces/$workspaceId/following/${check.id}",
        Api.body("action" to action, "revision" to check.revision, "quote" to quote),
    )
