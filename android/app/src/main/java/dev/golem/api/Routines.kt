package dev.golem.api

import kotlinx.serialization.Serializable

@Serializable
data class RoutineRun(
    val id: String,
    val routineId: String,
    val routineName: String,
    val startedAt: Double,
    val finishedAt: Double? = null,
    /** "running", "quiet", "posted", or "failed". */
    val outcome: String,
    val error: String? = null,
)

/** Work a topic does on a schedule, or each time a person arrives at or leaves its `place`. */
@Serializable
data class Routine(
    val id: String,
    val topicId: String,
    val name: String,
    /** A cron expression in the server's time zone; null for a routine at a place. */
    val schedule: String? = null,
    val place: RoutinePlace? = null,
    val instructions: String = "",
    val script: String? = null,
    val enabled: Boolean,
    /** Null while paused, and for a routine at a place. */
    val nextRunAt: Double? = null,
    val chatId: String? = null,
    val lastRun: RoutineRun? = null,
)

/** The place that a routine runs at, the event ("arrive" or "leave"), and the person whose phone reports it. */
@Serializable
data class RoutinePlace(
    val id: String,
    val name: String,
    val latitude: Double = 0.0,
    val longitude: Double = 0.0,
    val radius: Int = 0,
    val event: String,
    val personId: String = "",
) {
    /** "Arrive at Cottage", "Leave Office" */
    val summary get() = placeSummary(event, name)
}

/** "Arrive at Cottage", "Leave Office" */
fun placeSummary(event: String, name: String) = if (event == "arrive") "Arrive at $name" else "Leave $name"

@Serializable
data class TopicRoutines(val routines: List<Routine> = emptyList(), val runs: List<RoutineRun> = emptyList())

suspend fun Api.routines(workspaceId: String, topicId: String): TopicRoutines =
    get("/api/v1/workspaces/$workspaceId/topics/$topicId/routines")

suspend fun Api.setRoutine(id: String, enabled: Boolean): Routine =
    decode(send("PUT", "/api/v1/routines/$id", Api.body("enabled" to enabled)))

suspend fun Api.runRoutine(id: String) {
    send("POST", "/api/v1/routines/$id/runs")
}

suspend fun Api.deleteRoutine(id: String) {
    send("DELETE", "/api/v1/routines/$id")
}
