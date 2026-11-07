package dev.golem.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Each person's Upcoming: what Golem runs for them, what waits for them, and the automations Golem suggests.

@Serializable
data class Upcoming(
    /** Every routine the person sees. */
    val routines: List<Routine> = emptyList(),
    /** Pending, for the person or from them, soonest first. */
    val reminders: List<Reminder> = emptyList(),
    /** Oldest first; at most 3. */
    val suggestions: List<Suggestion> = emptyList(),
    /** What waits for the person to allow it. */
    val approvals: List<WaitingApproval> = emptyList(),
)

@Serializable
data class WaitingApproval(val threadId: String, val approval: Approval)

/**
 * A one-time reminder that an agent made; its agent reminds in `threadId` at `dueAt`, or when its recipient arrives at
 * or leaves its `place`.
 */
@Serializable
data class Reminder(
    val id: String,
    val threadId: String,
    val recipientId: String = "",
    val createdBy: String? = null,
    val text: String,
    /** For a reminder at a place: when it was made, until the phone reports the event. */
    val dueAt: Double,
    val timeZone: String = "",
    val place: ReminderPlace? = null,
    /** When the phone reported the event of a reminder at a place. */
    val triggeredAt: Double? = null,
    /** For a reminder at a place: it fires only from this time. */
    val notBefore: Double? = null,
    /** For a reminder at a place: it fires at this time anyway when its event has not come. */
    val notAfter: Double? = null,
    val deliveredAt: Double? = null,
    val cancelledAt: Double? = null,
) {
    /** A reminder at a place that waits for the phone to report its event. */
    val waitsForPlace get() = place != null && triggeredAt == null
}

/** The place that a reminder waits for, and whether for an arrival or a departure ("arrive" or "leave"). */
@Serializable
data class ReminderPlace(
    val id: String,
    val name: String,
    val latitude: Double = 0.0,
    val longitude: Double = 0.0,
    val radius: Int = 0,
    val event: String,
) {
    val summary get() = placeSummary(event, name)
}

/** A routine, a reminder, or a private channel that Golem suggests from a thread; nothing happens until the person accepts it. */
@Serializable
data class Suggestion(
    val id: String,
    /** "routine", "reminder", or "channel". */
    val kind: String,
    /** The routine's name, the reminder's text, or the channel's name. */
    val name: String,
    val text: String = "",
    /** A routine's cron expression in the server's time zone. */
    val schedule: String? = null,
    /** When the reminder is due, or the routine's first run. */
    @SerialName("at") val time: Double? = null,
    val channelId: String = "",
    val threadId: String = "",
    val createdAt: Double = 0.0,
)

suspend fun Api.upcoming(workspaceId: String): Upcoming = get("/api/v1/workspaces/$workspaceId/upcoming")

/** `accept` makes the suggestion the person's; else Golem does not suggest it again. */
suspend fun Api.answerSuggestion(workspaceId: String, suggestionId: String, accept: Boolean) {
    send("POST", "/api/v1/workspaces/$workspaceId/suggestions/$suggestionId", Api.body("accept" to accept))
}

suspend fun Api.cancelReminder(workspaceId: String, reminderId: String) {
    send("DELETE", "/api/v1/workspaces/$workspaceId/reminders/$reminderId")
}
