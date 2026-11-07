package dev.golem.phone

import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import dev.golem.api.Api
import dev.golem.api.FileRef
import dev.golem.api.PhoneCall
import dev.golem.api.answerPhoneCall
import dev.golem.api.phoneCalls
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import kotlinx.serialization.json.decodeFromJsonElement
import java.io.File
import java.time.Instant
import java.time.OffsetDateTime
import java.time.temporal.ChronoUnit
import java.util.UUID
import kotlin.coroutines.resume

/** What a tool answers: text for the agent, and JPEG pictures that it looks at. */
class PhoneAnswer(
    val text: String,
    val images: List<ByteArray> = emptyList(),
    /** What the tool does after Golem has the answer, such as opening another app, which closes the stream. */
    val after: (() -> Unit)? = null,
)

/** An error that the agent reads as the tool's failure. */
class PhoneError(message: String) : Exception(message)

/** A tool of the phone; `src/phone/tools.ts` describes them to the agents. */
typealias PhoneTool = suspend (Phone) -> PhoneAnswer

/**
 * Gives the agents the phone's tools while the app is on screen: it reads the calls of the person's turns from Golem,
 * runs each one with Android's own providers and apps, and sends the answer back. The stream stays open while a tool
 * waits for the person in another app, such as the camera, so that the call does not fail.
 */
class PhoneLink(private val activity: ComponentActivity, private val api: Api) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var stream: Job? = null
    private var started = false
    /** The tools that wait for the person in another screen or app. */
    private var waiting = 0

    /** Opens the stream, as when the app comes on screen. */
    fun start() {
        started = true
        if (stream == null) stream = scope.launch { follow() }
    }

    /** Closes the stream, as when the app goes from the screen, once no tool waits for the person. */
    fun stop() {
        started = false
        if (waiting > 0) return
        stream?.cancel()
        stream = null
    }

    fun close() = scope.cancel()

    /** Runs `action` with the stream kept open, also when the app goes from the screen meanwhile. */
    suspend fun <T> waiting(action: suspend () -> T): T {
        waiting++
        try {
            return action()
        } finally {
            waiting--
            if (!started) stop()
        }
    }

    /** Reads the calls until cancelled, and opens the stream again after each error. */
    private suspend fun follow() {
        while (scope.isActive) {
            runCatching { api.phoneCalls { call -> scope.launch { answer(call) } } }
                .onFailure { if (it is CancellationException) throw it }
            delay(2_000)
        }
    }

    private suspend fun answer(call: PhoneCall) {
        val answer = try {
            val tool = TOOLS[call.name] ?: throw PhoneError("This app has no tool ${call.name}; update it.")
            tool(Phone(activity, api, call, this))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            runCatching { api.answerPhoneCall(call.id, error.message ?: "The tool failed on the phone.") }
            return
        }
        runCatching { api.answerPhoneCall(call.id, answer.text, answer.images) }.onFailure { return }
        runCatching { answer.after?.invoke() }
    }

    companion object {
        /** Every tool, by its name without `phone_`; each tool of `src/phone/tools.ts` has an entry. */
        val TOOLS: Map<String, PhoneTool> = mapOf(
            "alarm_set" to Alarms::set,
            "timer_start" to Alarms::startTimer,
            "alarms" to Alarms::list,
            "alarm_change" to Alarms::change,
            "reminder_lists" to ::noReminders,
            "reminders" to ::noReminders,
            "reminder_add" to ::noReminders,
            "reminder_change" to ::noReminders,
            "reminder_delete" to ::noReminders,
            "calendars" to Calendars::calendars,
            "events" to Calendars::events,
            "event_add" to Calendars::addEvent,
            "event_change" to Calendars::changeEvent,
            "event_delete" to Calendars::deleteEvent,
            "contacts" to PhoneContacts::find,
            "contact_add" to PhoneContacts::add,
            "contact_change" to PhoneContacts::change,
            "message" to Compose::message,
            "mail" to Compose::mail,
            "call" to Compose::call,
            "music_play" to PhoneMusic::play,
            "music_control" to PhoneMusic::control,
            "photos" to PhoneLibrary::find,
            "photo" to PhoneLibrary::photo,
            "photo_save" to PhoneLibrary::save,
            "camera" to PhoneCamera::take,
            "health" to PhoneHealth::read,
            "health_log" to PhoneHealth::log,
            "location" to PhoneLocation::current,
            "directions" to PhoneLocation::directions,
            "open" to PhoneDevice::open,
            "clipboard" to PhoneDevice::clipboard,
            "device" to PhoneDevice::status,
            "flashlight" to PhoneDevice::flashlight,
            "brightness" to PhoneDevice::brightness,
            "home" to ::noHome,
            "home_scene" to ::noHome,
            "home_power" to ::noHome,
            "wallet_add" to ::noWallet,
        )

        @Suppress("UNUSED_PARAMETER", "RedundantSuspendModifier")
        private suspend fun noReminders(phone: Phone): PhoneAnswer = throw PhoneError(
            "Android has no reminders app that other apps can use. For a reminder that Golem sends, use " +
                "reminders_create; for a calendar entry, use phone_event_add."
        )

        @Suppress("UNUSED_PARAMETER", "RedundantSuspendModifier")
        private suspend fun noHome(phone: Phone): PhoneAnswer = throw PhoneError("Apple Home is only on the iPhone.")

        @Suppress("UNUSED_PARAMETER", "RedundantSuspendModifier")
        private suspend fun noWallet(phone: Phone): PhoneAnswer =
            throw PhoneError("Android cannot add a .pkpass file to a wallet from another app.")
    }
}

/** One call as a tool runs it: its arguments, the screen that asks the person, and the workspace's files. */
class Phone(val activity: ComponentActivity, val api: Api, val call: PhoneCall, private val link: PhoneLink) {
    val context get() = activity.applicationContext

    /** The arguments as the tool's own type; their keys are snake_case. */
    inline fun <reified T> arguments(): T = try {
        phoneJson.decodeFromJsonElement<T>(call.arguments)
    } catch (error: IllegalArgumentException) {
        throw PhoneError("The arguments are not valid: ${error.message}")
    }

    fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Asks the person for the permissions that are not granted yet; `what` names them in the error. */
    suspend fun allow(what: String, vararg permissions: String) {
        if (permissions.all(::granted)) return
        result(ActivityResultContracts.RequestMultiplePermissions(), arrayOf(*permissions))
        if (!permissions.all(::granted)) {
            throw PhoneError("The person did not allow Golem to use $what: Settings › Apps › Golem › Permissions.")
        }
    }

    /** Opens a screen of the system or another app, and waits until the person comes back from it. */
    suspend fun <I, O> result(contract: ActivityResultContract<I, O>, input: I): O = link.waiting {
        suspendCancellableCoroutine { continuation ->
            lateinit var launcher: ActivityResultLauncher<I>
            launcher = activity.activityResultRegistry.register("phone-${UUID.randomUUID()}", contract) {
                launcher.unregister()
                continuation.resume(it)
            }
            continuation.invokeOnCancellation { launcher.unregister() }
            launcher.launch(input)
        }
    }

    /** Downloads a file of the call's workspace, as the person can, into a folder that the caller removes. */
    suspend fun file(fileId: String): File =
        api.download(call.workspaceId, FileRef(id = fileId, name = ""), File(context.cacheDir, UUID.randomUUID().toString()))
}

/** The JSON of arguments and answers, with snake_case keys as the agents write them. */
@OptIn(ExperimentalSerializationApi::class)
val phoneJson = Json {
    namingStrategy = JsonNamingStrategy.SnakeCase
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

/** The value as JSON, which the agent reads. */
inline fun <reified T> jsonAnswer(value: T) = PhoneAnswer(phoneJson.encodeToString(value))

/** The time of an ISO 8601 argument with its UTC offset, with or without fractional seconds. */
fun date(text: String): Instant = try {
    OffsetDateTime.parse(text).toInstant()
} catch (_: Exception) {
    throw PhoneError("$text is not an ISO 8601 date and time with its UTC offset.")
}

/** A time as ISO 8601 in UTC to the second, as the iPhone answers. */
fun iso(instant: Instant): String = instant.truncatedTo(ChronoUnit.SECONDS).toString()

fun iso(milliseconds: Long): String = iso(Instant.ofEpochMilli(milliseconds))
