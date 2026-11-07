package dev.golem

import dev.golem.phone.Alarms
import dev.golem.phone.Calendars
import dev.golem.phone.PhoneContacts
import dev.golem.phone.PhoneError
import dev.golem.phone.PhoneHealth
import dev.golem.phone.PhoneLink
import dev.golem.phone.date
import dev.golem.phone.iso
import dev.golem.phone.phoneJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.Calendar

class PhoneTest {
    private val prague = ZoneId.of("Europe/Prague")

    @Test
    fun everyToolOfTheServerHasAnEntry() {
        val tools = File("../../src/phone/tools.ts").readText()
        val names = Regex("""name: "(\w+)"""").findAll(tools).map { it.groupValues[1] }.toSet()
        assertEquals(names, PhoneLink.TOOLS.keys)
    }

    @Serializable
    private data class Arguments(val fileId: String, val allDay: Boolean? = null)

    @Serializable
    private data class Answer(val freeStorageGb: Double, val at: String? = null)

    @Test
    fun argumentsAndAnswersUseSnakeCase() {
        assertEquals(Arguments("f1", true), phoneJson.decodeFromString<Arguments>("""{"file_id":"f1","all_day":true,"extra":1}"""))
        assertEquals("""{"free_storage_gb":1.5}""", phoneJson.encodeToString(Answer(1.5)))
    }

    @Test
    fun timesReadWithTheirOffsetAndWriteInUtc() {
        assertEquals(Instant.parse("2026-11-01T08:00:00Z"), date("2026-11-01T09:00:00+01:00"))
        assertEquals(Instant.parse("2026-11-01T08:00:00.500Z"), date("2026-11-01T08:00:00.5Z"))
        assertThrows(PhoneError::class.java) { date("tomorrow") }
        assertEquals("2026-11-01T08:00:00Z", iso(Instant.parse("2026-11-01T08:00:00.731Z")))
    }

    @Test
    fun alarmsTakeAClockTimeAndWeekdays() {
        assertEquals(6 to 30, Alarms.clockTime("06:30"))
        assertThrows(PhoneError::class.java) { Alarms.clockTime("24:00") }
        assertThrows(PhoneError::class.java) { Alarms.clockTime("6.30") }
        assertEquals(listOf(Calendar.MONDAY, Calendar.SUNDAY), Alarms.weekdayNumbers(listOf("monday", "sunday")))
        assertThrows(PhoneError::class.java) { Alarms.weekdayNumbers(listOf("someday")) }
    }

    @Test
    fun allDayEventsTakeWholeUtcDays() {
        val day = 86_400_000L
        val first = Instant.parse("2026-11-02T00:00:00Z").toEpochMilli()
        // One day, given as local midnight to local midnight.
        assertEquals(
            first to first + day,
            Calendars.allDayRange(date("2026-11-02T00:00:00+01:00"), date("2026-11-03T00:00:00+01:00"), prague),
        )
        // An end within the last day takes that day too, and an end before the start still takes one day.
        assertEquals(
            first to first + 2 * day,
            Calendars.allDayRange(date("2026-11-02T09:00:00+01:00"), date("2026-11-03T10:00:00+01:00"), prague),
        )
        assertEquals(first to first + day, Calendars.allDayRange(date("2026-11-02T09:00:00+01:00"), date("2026-11-01T10:00:00+01:00"), prague))
        assertEquals(date("2026-11-02T00:00:00+01:00"), Calendars.allDayLocal(first, prague))
    }

    @Test
    fun contactsTakeTheirLabelsAndBirthdays() {
        assertEquals(android.provider.ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE to null, PhoneContacts.phoneType(null))
        assertEquals(android.provider.ContactsContract.CommonDataKinds.Phone.TYPE_WORK to null, PhoneContacts.phoneType("Work"))
        assertEquals(android.provider.ContactsContract.CommonDataKinds.Phone.TYPE_CUSTOM to "cottage", PhoneContacts.phoneType("cottage"))
        assertEquals("1990-04-01", PhoneContacts.birthday("1990-04-01"))
        assertEquals("--04-01", PhoneContacts.birthday("--04-01"))
        assertThrows(PhoneError::class.java) { PhoneContacts.birthday("April 1") }
    }

    @Test
    fun healthSamplesGroupByLocalDay() {
        val days = PhoneHealth.dailyStatistics(
            listOf(
                date("2026-11-01T23:30:00+01:00") to 60.0,
                date("2026-11-01T08:00:00+01:00") to 71.0,
                date("2026-11-02T00:30:00+01:00") to 90.0,
            ),
            prague, "bpm",
        )
        assertEquals(
            listOf(
                PhoneHealth.Day("2026-11-01", average = 65.5, minimum = 60.0, maximum = 71.0, unit = "bpm"),
                PhoneHealth.Day("2026-11-02", average = 90.0, minimum = 90.0, maximum = 90.0, unit = "bpm"),
            ),
            days,
        )
    }

    @Test
    fun aPhoneCallReadsAsTheServerSendsIt() {
        val call = phoneJson.parseToJsonElement("""{"id":"c1","workspaceId":"w1","name":"device","arguments":{}}""").jsonObject
        assertEquals("w1", dev.golem.api.Api().json.decodeFromJsonElement(dev.golem.api.PhoneCall.serializer(), call).workspaceId)
    }
}
