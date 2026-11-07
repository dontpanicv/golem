package dev.golem.phone

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.database.Cursor
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars as CalendarTable
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Instances
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset

/** The calendars on the phone (`CalendarContract`), with every account that the person added to them. */
object Calendars {
    @Serializable
    private data class EventsArguments(val from: String, val to: String, val calendar: String? = null)

    @Serializable
    private data class EventArguments(
        val id: String? = null,
        val title: String? = null,
        val start: String? = null,
        val end: String? = null,
        val allDay: Boolean? = null,
        val calendar: String? = null,
        val location: String? = null,
        val notes: String? = null,
        val alertMinutes: Int? = null,
    )

    @Serializable
    private data class IdArguments(val id: String)

    @Serializable
    private data class CalendarRow(val name: String, val account: String, val writable: Boolean, val isDefault: Boolean)

    @Serializable
    private data class EventRow(
        val id: String,
        val title: String,
        val start: String,
        val end: String,
        val allDay: Boolean,
        val calendar: String,
        val location: String? = null,
        val notes: String? = null,
        val repeats: Boolean,
    )

    private data class Calendar(val id: Long, val name: String, val account: String, val writable: Boolean, val primary: Boolean)

    /** One occurrence of an event; `begin` and `end` as the provider keeps them, UTC midnights for an all-day event. */
    private data class Occurrence(
        val eventId: Long,
        val begin: Long,
        val end: Long,
        val allDay: Boolean,
        val title: String,
        val calendar: String,
        val location: String?,
        val notes: String?,
        val repeats: Boolean,
    ) {
        val id get() = if (repeats) "$eventId@${begin / 1000}" else "$eventId"
        val row get() = EventRow(
            id, title, iso(start), iso(finish), allDay, calendar, location?.ifEmpty { null }, notes?.ifEmpty { null }, repeats,
        )
        val start: Instant get() = if (allDay) allDayLocal(begin, ZoneId.systemDefault()) else Instant.ofEpochMilli(begin)
        val finish: Instant get() = if (allDay) allDayLocal(end, ZoneId.systemDefault()) else Instant.ofEpochMilli(end)
    }

    suspend fun calendars(phone: Phone): PhoneAnswer {
        access(phone)
        val calendars = calendarList(phone.context.contentResolver)
        val chosen = default(calendars)
        return jsonAnswer(calendars.map { CalendarRow(it.name, it.account, it.writable, it.id == chosen?.id) })
    }

    suspend fun events(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<EventsArguments>()
        access(phone)
        val resolver = phone.context.contentResolver
        val calendar = arguments.calendar?.let { calendar(resolver, it) }
        val rows = occurrences(resolver, date(arguments.from).toEpochMilli(), date(arguments.to).toEpochMilli(), calendar?.id)
        return jsonAnswer(rows.map { it.row })
    }

    suspend fun addEvent(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<EventArguments>()
        access(phone)
        val resolver = phone.context.contentResolver
        val calendars = calendarList(resolver)
        val calendar = arguments.calendar?.let { calendar(resolver, it) } ?: default(calendars)
            ?: throw PhoneError("This phone has no calendar that can change.")
        if (!calendar.writable) throw PhoneError("${calendar.name} cannot change.")
        val start = date(arguments.start ?: throw PhoneError("Give start and end."))
        val end = date(arguments.end ?: throw PhoneError("Give start and end."))
        val allDay = arguments.allDay == true
        val values = times(start, end, allDay).apply {
            put(Events.CALENDAR_ID, calendar.id)
            put(Events.TITLE, arguments.title.orEmpty())
            arguments.location?.let { put(Events.EVENT_LOCATION, it) }
            arguments.notes?.let { put(Events.DESCRIPTION, it) }
        }
        val eventId = withContext(Dispatchers.IO) {
            val uri = resolver.insert(Events.CONTENT_URI, values) ?: throw PhoneError("The calendar did not save the event.")
            val id = ContentUris.parseId(uri)
            arguments.alertMinutes?.let { minutes ->
                resolver.insert(CalendarContract.Reminders.CONTENT_URI, ContentValues().apply {
                    put(CalendarContract.Reminders.EVENT_ID, id)
                    put(CalendarContract.Reminders.MINUTES, minutes)
                    put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
                })
            }
            id
        }
        return jsonAnswer(
            Occurrence(
                eventId, values.getAsLong(Events.DTSTART), values.getAsLong(Events.DTEND), allDay, arguments.title.orEmpty(),
                calendar.name, arguments.location, arguments.notes, repeats = false,
            ).row
        )
    }

    suspend fun changeEvent(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<EventArguments>()
        access(phone)
        val resolver = phone.context.contentResolver
        val old = occurrence(resolver, arguments.id.orEmpty())
        val allDay = arguments.allDay ?: old.allDay
        val start = arguments.start?.let(::date) ?: old.start
        val end = arguments.end?.let(::date) ?: old.finish
        val values = times(start, end, allDay).apply {
            arguments.title?.let { put(Events.TITLE, it) }
            arguments.location?.let { put(Events.EVENT_LOCATION, it) }
            arguments.notes?.let { put(Events.DESCRIPTION, it) }
        }
        withContext(Dispatchers.IO) {
            if (old.repeats) {
                // A changed occurrence of a repeating event is an exception of it.
                values.put(Events.ORIGINAL_INSTANCE_TIME, old.begin)
                resolver.insert(ContentUris.withAppendedId(Events.CONTENT_EXCEPTION_URI, old.eventId), values)
                    ?: throw PhoneError("The calendar did not change the event.")
            } else {
                values.putNull(Events.DURATION)
                resolver.update(ContentUris.withAppendedId(Events.CONTENT_URI, old.eventId), values, null, null)
            }
        }
        return jsonAnswer(
            old.copy(
                begin = values.getAsLong(Events.DTSTART), end = values.getAsLong(Events.DTEND), allDay = allDay,
                title = arguments.title ?: old.title, location = arguments.location ?: old.location,
                notes = arguments.notes ?: old.notes,
            ).row
        )
    }

    suspend fun deleteEvent(phone: Phone): PhoneAnswer {
        val id = phone.arguments<IdArguments>().id
        access(phone)
        val resolver = phone.context.contentResolver
        val old = occurrence(resolver, id)
        withContext(Dispatchers.IO) {
            if (old.repeats) {
                val values = ContentValues().apply {
                    put(Events.ORIGINAL_INSTANCE_TIME, old.begin)
                    put(Events.STATUS, Events.STATUS_CANCELED)
                }
                resolver.insert(ContentUris.withAppendedId(Events.CONTENT_EXCEPTION_URI, old.eventId), values)
                    ?: throw PhoneError("The calendar did not delete the event.")
            } else {
                resolver.delete(ContentUris.withAppendedId(Events.CONTENT_URI, old.eventId), null, null)
            }
        }
        return PhoneAnswer("Deleted.")
    }

    /** The UTC midnights that an all-day event from `start` to `end` takes: Android keeps all-day events in UTC days. */
    fun allDayRange(start: Instant, end: Instant, zone: ZoneId): Pair<Long, Long> {
        val first = start.atZone(zone).toLocalDate()
        val ending = end.atZone(zone)
        var after = if (ending.toLocalTime() == LocalTime.MIDNIGHT) ending.toLocalDate() else ending.toLocalDate().plusDays(1)
        if (after <= first) after = first.plusDays(1)
        return first.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() to
            after.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
    }

    /** The local midnight of the day of an all-day event's UTC midnight. */
    fun allDayLocal(utcMidnight: Long, zone: ZoneId): Instant =
        Instant.ofEpochMilli(utcMidnight).atZone(ZoneOffset.UTC).toLocalDate().atStartOfDay(zone).toInstant()

    private fun times(start: Instant, end: Instant, allDay: Boolean) = ContentValues().apply {
        if (allDay) {
            val (first, after) = allDayRange(start, end, ZoneId.systemDefault())
            put(Events.DTSTART, first)
            put(Events.DTEND, after)
            put(Events.EVENT_TIMEZONE, "UTC")
        } else {
            if (end < start) throw PhoneError("end is before start.")
            put(Events.DTSTART, start.toEpochMilli())
            put(Events.DTEND, end.toEpochMilli())
            put(Events.EVENT_TIMEZONE, ZoneId.systemDefault().id)
        }
        put(Events.ALL_DAY, if (allDay) 1 else 0)
    }

    /** The occurrence that an id names: occurrences of a repeating event share its id, so theirs add `@` and the start. */
    private suspend fun occurrence(resolver: ContentResolver, id: String): Occurrence {
        val eventId = id.substringBefore('@').toLongOrNull() ?: throw PhoneError("There is no event $id.")
        val begin = id.substringAfter('@', "").toLongOrNull()?.times(1000)
        if (begin != null) {
            // The provider keeps all-day occurrences at UTC midnight, so the window is a day wide.
            return occurrences(resolver, begin - DAY, begin + DAY, null).firstOrNull { it.eventId == eventId && it.begin == begin }
                ?: throw PhoneError("There is no event $id.")
        }
        val event = withContext(Dispatchers.IO) {
            resolver.query(
                ContentUris.withAppendedId(Events.CONTENT_URI, eventId),
                arrayOf(Events.DTSTART, Events.DTEND, Events.ALL_DAY, Events.TITLE, Events.CALENDAR_DISPLAY_NAME,
                    Events.EVENT_LOCATION, Events.DESCRIPTION, Events.RRULE, Events.DELETED),
                null, null, null,
            )?.use { cursor ->
                if (!cursor.moveToFirst() || cursor.getInt(8) == 1) return@use null
                if (cursor.getString(7) != null) {
                    throw PhoneError("$id repeats: give the id of one occurrence, as phone_events lists it.")
                }
                Occurrence(
                    eventId, cursor.getLong(0), cursor.getLong(1), cursor.getInt(2) == 1, cursor.getString(3).orEmpty(),
                    cursor.getString(4).orEmpty(), cursor.getString(5), cursor.getString(6), repeats = false,
                )
            }
        }
        return event ?: throw PhoneError("There is no event $id.")
    }

    private suspend fun occurrences(resolver: ContentResolver, from: Long, to: Long, calendarId: Long?): List<Occurrence> =
        withContext(Dispatchers.IO) {
            val uri = Instances.CONTENT_URI.buildUpon().also {
                ContentUris.appendId(it, from)
                ContentUris.appendId(it, to)
            }.build()
            resolver.query(
                uri,
                arrayOf(Instances.EVENT_ID, Instances.BEGIN, Instances.END, Instances.ALL_DAY, Instances.TITLE,
                    Instances.CALENDAR_DISPLAY_NAME, Instances.EVENT_LOCATION, Instances.DESCRIPTION, Instances.RRULE,
                    Instances.RDATE, Instances.ORIGINAL_ID),
                calendarId?.let { "${Instances.CALENDAR_ID} = ?" }, calendarId?.let { arrayOf(it.toString()) },
                "${Instances.BEGIN} ASC",
            )?.use { cursor ->
                cursor.rows {
                    val exception = !cursor.isNull(10)
                    Occurrence(
                        eventId = cursor.getLong(0), begin = cursor.getLong(1), end = cursor.getLong(2),
                        allDay = cursor.getInt(3) == 1, title = cursor.getString(4).orEmpty(),
                        calendar = cursor.getString(5).orEmpty(), location = cursor.getString(6), notes = cursor.getString(7),
                        repeats = !cursor.isNull(8) || !cursor.isNull(9) || exception,
                    )
                }
            }.orEmpty()
        }

    private suspend fun calendarList(resolver: ContentResolver): List<Calendar> = withContext(Dispatchers.IO) {
        resolver.query(
            CalendarTable.CONTENT_URI,
            arrayOf(CalendarTable._ID, CalendarTable.CALENDAR_DISPLAY_NAME, CalendarTable.ACCOUNT_NAME,
                CalendarTable.CALENDAR_ACCESS_LEVEL, CalendarTable.IS_PRIMARY),
            "${CalendarTable.VISIBLE} = 1", null, null,
        )?.use { cursor ->
            cursor.rows {
                Calendar(
                    cursor.getLong(0), cursor.getString(1).orEmpty(), cursor.getString(2).orEmpty(),
                    cursor.getInt(3) >= CalendarTable.CAL_ACCESS_CONTRIBUTOR, cursor.getInt(4) == 1,
                )
            }
        }.orEmpty()
    }

    /** The calendar for new events: the primary one of an account that can change, else the first that can. */
    private fun default(calendars: List<Calendar>) =
        calendars.firstOrNull { it.writable && it.primary } ?: calendars.firstOrNull { it.writable }

    private suspend fun calendar(resolver: ContentResolver, name: String): Calendar {
        val calendars = calendarList(resolver)
        return calendars.firstOrNull { it.name.equals(name, ignoreCase = true) }
            ?: throw PhoneError("There is no $name. Name one of: ${calendars.joinToString(", ") { it.name }}.")
    }

    private suspend fun access(phone: Phone) =
        phone.allow("Calendar", Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)

    private const val DAY = 86_400_000L
}

/** Each row of the cursor, as `read` makes it. */
inline fun <T> Cursor.rows(read: () -> T): List<T> = buildList { while (moveToNext()) add(read()) }
