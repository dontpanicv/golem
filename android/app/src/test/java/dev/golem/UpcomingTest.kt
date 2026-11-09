package dev.golem

import dev.golem.api.Approval
import dev.golem.api.Reminder
import dev.golem.api.ReminderPlace
import dev.golem.api.Routine
import dev.golem.api.RoutinePlace
import dev.golem.api.RoutineRun
import dev.golem.api.Suggestion
import dev.golem.api.Upcoming
import dev.golem.api.WaitingApproval
import dev.golem.api.sourceName
import dev.golem.views.UpcomingKind
import dev.golem.views.groups
import dev.golem.views.placeWindow
import dev.golem.views.savedFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/**
 * Upcoming puts what needs the person first, then the suggestions, then routines and reminders by day, soonest first,
 * then the reminders that wait for a place, then the routines at a place, then the paused routines.
 */
class UpcomingTest {
    private val utc = ZoneOffset.UTC
    /** Saturday 31 October 2026, 10:00 UTC. */
    private val now = 1_793_440_800_000L

    private fun hours(hours: Double) = now + hours * 3_600_000

    private fun routine(id: String, at: Double?, enabled: Boolean = true, outcome: String? = null, place: RoutinePlace? = null) =
        Routine(
            id = id, topicId = "general", name = id, schedule = if (place == null) "0 8 * * *" else null, place = place,
            enabled = enabled, nextRunAt = if (enabled) at else null,
            lastRun = outcome?.let { RoutineRun("run", id, id, 0.0, 0.0, it) },
        )

    private fun reminder(id: String, at: Double, place: ReminderPlace? = null, from: Double? = null, until: Double? = null) =
        Reminder(id = id, chatId = "chat", text = id, dueAt = at, place = place, notBefore = from, notAfter = until)

    @Test
    fun aPlaceReminderShowsItsWindow() {
        val office = ReminderPlace("office", "Office", event = "arrive")
        assertEquals("Arrive at Office", placeWindow(reminder("plain", 0.0, office)))
        val window = placeWindow(reminder("monday", 0.0, office, from = hours(30.0), until = hours(36.0))) ?: ""
        assertTrue(window, window.startsWith("Arrive at Office · from "))
        assertTrue(window, window.contains(" · until "))
        assertNull(placeWindow(reminder("time", 0.0)))
    }

    @Test
    fun groupsComeInOrderAndOnlyWithItems() {
        val cottage = RoutinePlace("cottage", "Cottage", 49.1, 16.2, 300, "leave", "me")
        val upcoming = Upcoming(
            routines = listOf(
                routine("weekly", hours(24.0 * 9)),
                routine("broken", hours(1.0), outcome = "failed"),
                routine("stopped", null, enabled = false),
                routine("morning", hours(22.0), outcome = "posted"),
                routine("heating", null, place = cottage),
            ),
            reminders = listOf(
                reminder("soon", hours(1.0)), reminder("friday", hours(24.0 * 5)), reminder("now", hours(-1.0)),
                reminder("tent", hours(-2.0), ReminderPlace("cottage", "Cottage", event = "arrive")),
            ),
            suggestions = listOf(Suggestion("idea", "reminder", "Call", time = hours(30.0))),
            approvals = listOf(WaitingApproval("chat", Approval("allow", "hands_exec", "Run", expiresAt = 0.0))),
        )

        val groups = upcoming.groups(now, utc)

        assertEquals(UpcomingKind.entries.toList(), groups.map { it.kind })
        assertEquals(
            mapOf(
                "Needs you" to listOf("approval:allow", "routine:broken"),
                "Suggested" to listOf("suggestion:idea"),
                "Today" to listOf("reminder:now", "reminder:soon"),
                "Tomorrow" to listOf("routine:morning"),
                "This week" to listOf("reminder:friday"),
                "Later" to listOf("routine:weekly"),
                "At a place" to listOf("reminder:tent"),
                "Routines at a place" to listOf("routine:heating"),
                "Paused" to listOf("routine:stopped"),
            ),
            groups.associate { group -> group.kind.title to group.items.map { it.id } },
        )
    }

    @Test
    fun nothingUpcomingHasNoGroups() {
        assertTrue(Upcoming().groups(now, utc).isEmpty())
    }

    @Test
    fun aSourceReadsAsItsSenderAndConversation() {
        assertEquals("Alice · Balcony", sourceName("Mail (a@b.c); Balcony; Alice"))
        assertEquals("Mail", sourceName("Mail"))
    }

    @Test
    fun savedFilesOpenFromTheirSearchUri() {
        val id = "0190f5a2-1c3b-7d4e-8f90-123456789abc"
        assertEquals(id, savedFile("topics/general/files/$id-bill.pdf")?.id)
        assertEquals("bill.pdf", savedFile("files/$id-bill.pdf")?.name)
        assertNull(savedFile("chat:abc"))
    }
}
