package dev.golem.places

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import dev.golem.GolemApp
import dev.golem.MainActivity
import dev.golem.R
import dev.golem.api.ApiException
import dev.golem.api.WatchedPlace
import dev.golem.api.reportPlace
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Watches the places that Golem gives for the person (`watched-places`) with the geofences of Play services, and tells
 * Golem when they arrive or leave; only that goes to Golem, never where the person is, and Golem decides what is due.
 * Android starts the app in the background for a crossing (`PlaceReceiver`), also when it does not run, and forgets
 * the geofences when the phone restarts, so the receiver adds them again after a restart.
 */
object PlaceWatcher {
    /** What the watcher keeps of a place across launches. */
    @Serializable
    private data class Watched(
        val workspaceId: String,
        val place: WatchedPlace,
        /** Whether the person was in the circle when Android last said; null until Android first says after the watch starts. */
        val inside: Boolean? = null,
    )

    /** What the phone saw at a place; it waits here until Golem has it, as without a connection. */
    @Serializable
    private data class Report(
        val workspaceId: String,
        val placeId: String,
        val event: String,
        /** When it happened, in Unix milliseconds. */
        val time: Long,
        /** The first state after the watch started, which is no crossing. */
        val initial: Boolean,
    )

    /** Whether places wait for the location all the time, which the person has not allowed (`PlacePermission`). */
    var needsPermission by mutableStateOf(false)
        private set

    private val mutex = Mutex()
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Watches the places that Golem gives for the person in the workspace, stops watching the others, and sends the
     * reports that Golem did not get.
     */
    suspend fun watch(context: Context, places: List<WatchedPlace>, workspaceId: String) = mutex.withLock {
        sendReports(context)
        val watched = watched(context).toMutableMap()
        val wanted = places.associateBy { it.id }
        watched.keys.removeAll { watched.getValue(it).workspaceId == workspaceId && it !in wanted }
        for ((id, place) in wanted) {
            val item = watched[id]
            watched[id] = if (item != null && item.workspaceId == workspaceId && sameCircle(item.place, place)) {
                // The same circle, maybe with other reminders.
                item.copy(place = place)
            } else {
                Watched(workspaceId, place)
            }
        }
        save(context, WATCHED, watched)
        register(context, watched.values)
    }

    /** Adds the geofences again, as after the phone restarts. */
    suspend fun resume(context: Context) = mutex.withLock { register(context, watched(context).values) }

    /** Stops watching every place, as after the person signs out. */
    suspend fun stop(context: Context) = mutex.withLock {
        runCatching { LocationServices.getGeofencingClient(context).removeGeofences(intent(context)).await() }
        preferences(context).edit().clear().apply()
        needsPermission = false
    }

    /** A crossing that Android saw: it goes to Golem, or without a connection shows the place's reminders itself. */
    suspend fun handle(context: Context, event: GeofencingEvent) = mutex.withLock {
        // A geofence error, as when the location is off, ends the watch until the app adds the geofences again.
        if (event.hasError()) return@withLock
        val inside = when (event.geofenceTransition) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> true
            Geofence.GEOFENCE_TRANSITION_EXIT -> false
            else -> return@withLock
        }
        val time = event.triggeringLocation?.time ?: System.currentTimeMillis()
        val watched = watched(context).toMutableMap()
        val added = event.triggeringGeofences.orEmpty().mapNotNull { geofence ->
            val item = watched[geofence.requestId] ?: return@mapNotNull null
            if (item.inside == inside) return@mapNotNull null
            watched[geofence.requestId] = item.copy(inside = inside)
            Report(item.workspaceId, geofence.requestId, if (inside) "arrive" else "leave", time, initial = item.inside == null)
        }
        if (added.isEmpty()) return@withLock
        save(context, WATCHED, watched)
        save(context, REPORTS, reports(context) + added)
        // A broadcast has about 10 seconds; what does not go waits for the next crossing or the next app start.
        withTimeoutOrNull(8_000) { sendReports(context) }
        val unsent = reports(context)
        for (report in added.filter { it in unsent }) {
            val item = watched[report.placeId] ?: continue
            // Without a connection, as in the mountains, the person still gets the reminders that Golem would make due.
            val due = item.place.reminders.filter { it.event == report.event && (!report.initial || report.event == "arrive") }
            due.forEach { notify(context, it.id, it.text) }
            watched[report.placeId] = item.copy(place = item.place.copy(reminders = item.place.reminders - due.toSet()))
        }
        save(context, WATCHED, watched)
    }

    /** Sends the waiting reports in order, until one cannot go. */
    private suspend fun sendReports(context: Context) {
        val api = (context.applicationContext as GolemApp).session.api
        if (api.token == null) return
        for (report in reports(context)) {
            try {
                api.reportPlace(report.workspaceId, report.placeId, report.event, report.time, report.initial)
            } catch (error: ApiException) {
                // 400 or 404: Golem no longer watches the place for the person.
                if (error.status != 400 && error.status != 404) return
            } catch (_: Exception) {
                return
            }
            save(context, REPORTS, reports(context) - report)
        }
    }

    /**
     * Replaces the app's geofences with those of the watched places. Android says the first state of each at once, as
     * an entry or an exit, which the watcher reports as initial while it knows no state yet.
     */
    @SuppressLint("MissingPermission")
    private suspend fun register(context: Context, watched: Collection<Watched>) {
        val client = LocationServices.getGeofencingClient(context)
        runCatching { client.removeGeofences(intent(context)).await() }
        val allowed = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            .all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
        needsPermission = watched.isNotEmpty() && !allowed
        if (watched.isEmpty() || !allowed) return
        val geofences = watched.map {
            Geofence.Builder()
                .setRequestId(it.place.id)
                .setCircularRegion(it.place.latitude, it.place.longitude, it.place.radius.toFloat())
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)
                .build()
        }
        val request = GeofencingRequest.Builder()
            .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER or GeofencingRequest.INITIAL_TRIGGER_EXIT)
            .addGeofences(geofences)
            .build()
        // The location may be off; the app adds them again when it opens or goes to the background.
        runCatching { client.addGeofences(request, intent(context)).await() }
    }

    private fun intent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context, 0, Intent(context, PlaceReceiver::class.java).setAction(CROSSED),
        // Play services adds the crossing to the intent.
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )

    @SuppressLint("MissingPermission")
    private fun notify(context: Context, id: String, text: String) {
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "Reminders at places", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Golem")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .build()
        NotificationManagerCompat.from(context).notify(id, 0, notification)
    }

    private fun sameCircle(first: WatchedPlace, second: WatchedPlace) =
        first.latitude == second.latitude && first.longitude == second.longitude && first.radius == second.radius

    private fun preferences(context: Context) = context.getSharedPreferences("places", Context.MODE_PRIVATE)

    private fun watched(context: Context): Map<String, Watched> =
        preferences(context).getString(WATCHED, null)?.let { runCatching { json.decodeFromString<Map<String, Watched>>(it) }.getOrNull() }
            .orEmpty()

    /** The reports that Golem did not get yet, oldest first. */
    private fun reports(context: Context): List<Report> =
        preferences(context).getString(REPORTS, null)?.let { runCatching { json.decodeFromString<List<Report>>(it) }.getOrNull() }
            .orEmpty()

    private inline fun <reified T> save(context: Context, key: String, value: T) {
        // commit: the process may end soon after a broadcast.
        preferences(context).edit().putString(key, json.encodeToString(value)).commit()
    }

    private const val WATCHED = "watched"
    private const val REPORTS = "reports"
    private const val CHANNEL = "places"
    const val CROSSED = "dev.golem.places.CROSSED"
}

/** Gets the crossings of the watched places, and adds the geofences again after the phone restarts. */
class PlaceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                when (intent.action) {
                    Intent.ACTION_BOOT_COMPLETED -> PlaceWatcher.resume(context)
                    PlaceWatcher.CROSSED -> GeofencingEvent.fromIntent(intent)?.let { PlaceWatcher.handle(context, it) }
                }
            } finally {
                pending.finish()
            }
        }
    }
}
