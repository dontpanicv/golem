package dev.golem.api

import kotlinx.serialization.Serializable

/** A report of an agent about Golem, which the server's owner reads. */
@Serializable
data class Feedback(
    val id: String,
    /** "error", "missing", or "better". */
    val kind: String,
    val tool: String? = null,
    val summary: String,
    val detail: String = "",
    /** Null when the owner does not see the chat, such as another person's private topic. */
    val chatId: String? = null,
    val createdAt: Double,
)

@Serializable
private data class FeedbackList(val feedback: List<Feedback>)

suspend fun Api.feedback(workspaceId: String): List<Feedback> =
    get<FeedbackList>("/api/v1/workspaces/$workspaceId/feedback").feedback

suspend fun Api.dismissFeedback(workspaceId: String, feedbackId: String) {
    send("DELETE", "/api/v1/workspaces/$workspaceId/feedback/$feedbackId")
}
