package dev.golem.api

import kotlinx.serialization.Serializable

/** A place that the phone watches for the person, with its pending reminders, which it shows without a connection. */
@Serializable
data class WatchedPlace(
    val id: String,
    val name: String,
    val latitude: Double,
    val longitude: Double,
    val radius: Double,
    val reminders: List<PlaceReminder> = emptyList(),
)

/** `event`: "arrive" or "leave". */
@Serializable
data class PlaceReminder(val id: String, val text: String, val event: String)

@Serializable
private data class WatchedPlaces(val places: List<WatchedPlace>)

suspend fun Api.watchedPlaces(workspaceId: String): List<WatchedPlace> =
    get<WatchedPlaces>("/api/v1/workspaces/$workspaceId/watched-places").places

/** Tells Golem that the person arrived at or left a place; `at` is Unix milliseconds. */
suspend fun Api.reportPlace(workspaceId: String, placeId: String, event: String, at: Long, initial: Boolean) {
    send(
        "POST", "/api/v1/workspaces/$workspaceId/watched-places/$placeId/reports",
        Api.body("event" to event, "at" to at, "initial" to initial),
    )
}
