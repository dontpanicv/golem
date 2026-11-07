package dev.golem.phone

import android.content.Context
import android.content.Intent
import android.provider.AlarmClock
import kotlinx.serialization.Serializable
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.util.Calendar
import java.util.UUID

/**
 * Alarms and timers of the phone's Clock app (`AlarmClock` intents). Android does not show the Clock's alarms to other
 * apps, so the tools list the ones that Golem set, as Golem noted them; the person can change them in Clock.
 */
object Alarms {
    @Serializable
    private data class SetArguments(
        val label: String,
        val time: String? = null,
        val weekdays: List<String>? = null,
        val at: String? = null,
    )

    @Serializable
    private data class TimerArguments(val label: String, val seconds: Int)

    @Serializable
    private data class ChangeArguments(val id: String, val action: String)

    /** What Golem noted of an alarm or a timer that it set; `at` and `startedAt` are Unix milliseconds. */
    @Serializable
    private data class Noted(
        val id: String,
        val label: String,
        val timer: Boolean = false,
        val time: String? = null,
        val weekdays: List<String>? = null,
        val at: Long? = null,
        val seconds: Int? = null,
        val startedAt: Long = 0,
    )

    @Serializable
    private data class Listed(
        val id: String,
        val label: String,
        val state: String,
        val time: String? = null,
        val weekdays: List<String>? = null,
        val at: String? = null,
        val seconds: Double? = null,
    )

    private const val KEY = "phoneAlarms"

    suspend fun set(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<SetArguments>()
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_MESSAGE, arguments.label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        val noted: Noted
        val id = UUID.randomUUID().toString()
        if (arguments.at != null) {
            val at = date(arguments.at)
            val left = Duration.between(Instant.now(), at)
            if (left.isNegative || left > Duration.ofHours(24)) {
                throw PhoneError("Android's Clock sets an alarm only by time of day: give time, or an at in the next 24 hours.")
            }
            val local = at.atZone(ZoneId.systemDefault())
            intent.putExtra(AlarmClock.EXTRA_HOUR, local.hour).putExtra(AlarmClock.EXTRA_MINUTES, local.minute)
            noted = Noted(id, arguments.label, at = at.toEpochMilli())
        } else if (arguments.time != null) {
            val (hour, minute) = clockTime(arguments.time)
            val days = weekdayNumbers(arguments.weekdays.orEmpty())
            intent.putExtra(AlarmClock.EXTRA_HOUR, hour).putExtra(AlarmClock.EXTRA_MINUTES, minute)
            if (days.isNotEmpty()) intent.putExtra(AlarmClock.EXTRA_DAYS, ArrayList(days))
            noted = Noted(id, arguments.label, time = "%02d:%02d".format(hour, minute), weekdays = arguments.weekdays?.ifEmpty { null })
        } else {
            throw PhoneError("Give time or at.")
        }
        if (intent.resolveActivity(phone.context.packageManager) == null) throw PhoneError("This phone has no Clock app.")
        note(phone.context, noted)
        return PhoneAnswer("Alarm set in the Clock app, id $id.") { phone.activity.startActivity(intent) }
    }

    suspend fun startTimer(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<TimerArguments>()
        if (arguments.seconds !in 1..86_400) throw PhoneError("seconds must be from 1 to 86400.")
        val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, arguments.seconds)
            .putExtra(AlarmClock.EXTRA_MESSAGE, arguments.label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        if (intent.resolveActivity(phone.context.packageManager) == null) throw PhoneError("This phone has no Clock app.")
        val id = UUID.randomUUID().toString()
        note(phone.context, Noted(id, arguments.label, timer = true, seconds = arguments.seconds, startedAt = System.currentTimeMillis()))
        return PhoneAnswer("Timer started in the Clock app, id $id.") { phone.activity.startActivity(intent) }
    }

    @Suppress("RedundantSuspendModifier")
    suspend fun list(phone: Phone): PhoneAnswer {
        val now = System.currentTimeMillis()
        // Alarms at one date and timers that ended go.
        val current = noted(phone.context).filter { item ->
            (item.at == null || item.at > now) && (!item.timer || item.startedAt + (item.seconds ?: 0) * 1000L > now)
        }
        save(phone.context, current)
        return jsonAnswer(current.map {
            Listed(
                id = it.id, label = it.label, state = if (it.timer) "countdown" else "scheduled", time = it.time,
                weekdays = it.weekdays, at = it.at?.let(::iso), seconds = it.seconds?.toDouble(),
            )
        })
    }

    suspend fun change(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<ChangeArguments>()
        val item = noted(phone.context).firstOrNull { it.id == arguments.id } ?: throw PhoneError("There is no alarm ${arguments.id}.")
        val intent = when {
            arguments.action !in listOf("cancel", "stop", "pause", "resume") ->
                throw PhoneError("action must be cancel, stop, pause, or resume.")
            arguments.action == "pause" || arguments.action == "resume" ->
                throw PhoneError("Android's Clock does not let other apps pause or resume a timer.")
            item.timer && arguments.action == "cancel" ->
                throw PhoneError("Android's Clock lets other apps stop only a ringing timer; the person cancels this one in Clock.")
            item.timer -> Intent(AlarmClock.ACTION_DISMISS_TIMER)
            else -> Intent(AlarmClock.ACTION_DISMISS_ALARM)
                .putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE, AlarmClock.ALARM_SEARCH_MODE_LABEL)
                .putExtra(AlarmClock.EXTRA_MESSAGE, item.label)
        }
        // A repeating alarm that stops ringing rings again on its next day.
        if (arguments.action == "cancel" || item.weekdays == null) save(phone.context, noted(phone.context) - item)
        return PhoneAnswer("Done: ${arguments.action}.") { phone.activity.startActivity(intent) }
    }

    /** The hour and minute of `HH:MM`. */
    fun clockTime(text: String): Pair<Int, Int> {
        val parts = text.split(":").map { it.toIntOrNull() }
        val hour = parts.getOrNull(0)
        val minute = parts.getOrNull(1)
        if (parts.size != 2 || hour == null || minute == null || hour !in 0..23 || minute !in 0..59) {
            throw PhoneError("time must be HH:MM, such as 06:30.")
        }
        return hour to minute
    }

    /** The `Calendar` day numbers of weekday names, as the Clock's `EXTRA_DAYS` takes them. */
    fun weekdayNumbers(names: List<String>): List<Int> = names.map { name ->
        WEEKDAYS[name] ?: throw PhoneError("$name is not a weekday.")
    }

    private val WEEKDAYS = mapOf(
        "monday" to Calendar.MONDAY, "tuesday" to Calendar.TUESDAY, "wednesday" to Calendar.WEDNESDAY,
        "thursday" to Calendar.THURSDAY, "friday" to Calendar.FRIDAY, "saturday" to Calendar.SATURDAY,
        "sunday" to Calendar.SUNDAY,
    )

    private fun noted(context: Context): List<Noted> =
        context.getSharedPreferences("phone", Context.MODE_PRIVATE).getString(KEY, null)
            ?.let { runCatching { phoneJson.decodeFromString<List<Noted>>(it) }.getOrNull() }.orEmpty()

    private fun note(context: Context, item: Noted) = save(context, noted(context) + item)

    private fun save(context: Context, items: List<Noted>) {
        context.getSharedPreferences("phone", Context.MODE_PRIVATE).edit()
            .putString(KEY, phoneJson.encodeToString(items)).apply()
    }
}
