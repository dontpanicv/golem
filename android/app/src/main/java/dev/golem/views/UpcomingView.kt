package dev.golem.views

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.golem.api.Approval
import dev.golem.api.Destination
import dev.golem.api.Reminder
import dev.golem.api.Routine
import dev.golem.api.Suggestion
import dev.golem.api.Upcoming
import dev.golem.api.answerSuggestion
import dev.golem.api.cancelReminder
import dev.golem.api.deleteRoutine
import dev.golem.api.runRoutine
import dev.golem.api.setRoutine
import dev.golem.api.upcoming
import dev.golem.design.ButtonSize
import dev.golem.design.ButtonVariant
import dev.golem.design.EmptyState
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemMenu
import dev.golem.design.GolemSwitch
import dev.golem.design.ListPadding
import dev.golem.design.ListRow
import dev.golem.design.ListSectionHeader
import dev.golem.design.ListSeparator
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.Tokens
import dev.golem.design.golemText
import dev.golem.design.raisedCard
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * What Golem runs for the person and what waits for them, soonest first: what needs them, what Golem suggests, the
 * routines and reminders by day, the reminders that wait for a place, the routines at a place, and the paused
 * routines. Routines pause, run, and go here; reminders cancel here.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UpcomingList(header: @Composable () -> Unit) {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var upcoming by remember { mutableStateOf<Upcoming?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    val groups = upcoming?.groups().orEmpty()

    suspend fun load() {
        val workspace = session.workspace ?: return
        upcoming = session.api.upcoming(workspace.id)
    }

    fun replace(changed: Routine) {
        upcoming = upcoming?.let { it.copy(routines = it.routines.map { routine -> if (routine.id == changed.id) changed else routine }) }
    }

    // Approvals come and go as agents work.
    LaunchedEffect(session.working) { session.run { load() } }

    Scaffold(containerColor = Golem.mobile.background, topBar = header) { padding ->
        PullToRefreshBox(
            refreshing, onRefresh = {
                refreshing = true
                scope.launch {
                    session.run { load() }
                    refreshing = false
                }
            },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
                groups.forEach { group ->
                    item(key = "header:${group.kind}") {
                        ListSeparator()
                        ListSectionHeader(group.kind.title)
                    }
                    items(group.items, key = { it.id }) { item ->
                        Box(Modifier.animateItem()) {
                            when (item) {
                                is UpcomingItem.ApprovalItem -> ApprovalRow(item.threadId, item.approval)
                                is UpcomingItem.RoutineItem -> RoutineRow(item.routine, group.kind, ::replace) {
                                    upcoming = upcoming?.let { it.copy(routines = it.routines - item.routine) }
                                }
                                is UpcomingItem.ReminderItem -> ReminderRow(item.reminder, group.kind) {
                                    upcoming = upcoming?.let { it.copy(reminders = it.reminders - item.reminder) }
                                }
                                is UpcomingItem.SuggestionItem -> SuggestionCard(item.suggestion, card = false) {
                                    upcoming = upcoming?.let { it.copy(suggestions = it.suggestions - item.suggestion) }
                                    scope.launch { quietly { load() } }
                                }
                            }
                        }
                    }
                }
            }
            if (upcoming != null && groups.isEmpty()) {
                EmptyState("Nothing upcoming", { Icon(Icons.Outlined.CalendarMonth, null, tint = Golem.colors.textQuaternary) })
            }
        }
    }
}

@Composable
private fun ApprovalRow(threadId: String, approval: Approval) {
    val session = LocalSession.current
    val open = LocalOpen.current
    val title = if (threadId == session.orchestrator?.id) "Golem"
    else session.channels.flatMap { it.threads }.firstOrNull { it.id == threadId }?.title
    ListRow(approval.text, icon = Icons.Outlined.PanTool, subtitle = title, onClick = { open(Destination.Thread(threadId)) })
}

/** A routine: it opens its thread, or its channel before its first run; the switch pauses it, the menu runs or deletes it. */
@Composable
private fun RoutineRow(routine: Routine, kind: UpcomingKind, changed: (Routine) -> Unit, deleted: () -> Unit) {
    val session = LocalSession.current
    val open = LocalOpen.current
    val channel = session.channels.firstOrNull { it.id == routine.channelId }?.let { "#${it.name}" }
    val detail = when (kind) {
        UpcomingKind.NeedsYou -> routine.lastRun?.error ?: "Failed"
        UpcomingKind.Paused -> "Paused"
        UpcomingKind.RoutinesAtPlace -> routine.place?.summary
        else -> routine.nextRunAt?.let { upcomingTime(it, kind) } ?: routine.schedule
    }
    ListRow(
        routine.name, icon = if (routine.place == null) Icons.Outlined.Refresh else Icons.Outlined.Place,
        subtitle = listOfNotNull(channel, detail).joinToString(" · "),
        onClick = { open(routine.threadId?.let { Destination.Thread(it) } ?: Destination.Channel(routine.channelId)) },
    ) {
        GolemSwitch(routine.enabled, { enabled ->
            changed(routine.copy(enabled = enabled))
            session.launch {
                try {
                    changed(session.api.setRoutine(routine.id, enabled))
                } catch (error: Exception) {
                    changed(routine)
                    throw error
                }
            }
        }, label = "Run ${routine.name}")
        RowMenu("${routine.name} actions", listOf(
            MenuAction("Run now", Icons.Outlined.PlayArrow) {
                session.launch {
                    session.api.runRoutine(routine.id)
                    session.show("${routine.name} runs now", dev.golem.api.Toast.Tone.Success)
                }
            },
            MenuAction("Delete", Icons.Outlined.Delete, danger = true) {
                session.launch {
                    session.api.deleteRoutine(routine.id)
                    deleted()
                    session.show("${routine.name} deleted", dev.golem.api.Toast.Tone.Success)
                }
            },
        ))
    }
}

@Composable
private fun ReminderRow(reminder: Reminder, kind: UpcomingKind, cancelled: () -> Unit) {
    val session = LocalSession.current
    val open = LocalOpen.current
    ListRow(
        reminder.text, icon = if (reminder.place == null) Icons.Outlined.Notifications else Icons.Outlined.Place,
        subtitle = if (reminder.waitsForPlace) placeWindow(reminder) else upcomingTime(reminder.dueAt, kind),
        onClick = { open(Destination.Thread(reminder.threadId)) },
    ) {
        RowMenu("Reminder actions", listOf(
            MenuAction("Cancel reminder", Icons.Outlined.Close, danger = true) {
                val workspace = session.workspace ?: return@MenuAction
                session.launch {
                    session.api.cancelReminder(workspace.id, reminder.id)
                    cancelled()
                }
            },
        ))
    }
}

/** The actions of a row in a menu at its end, beside the row's own tap. */
@Composable
private fun RowMenu(label: String, items: List<MenuAction>) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton({ expanded = true }) { Icon(Icons.Outlined.MoreVert, label, Modifier.size(18.dp), tint = Golem.mobile.textTertiary) }
        GolemMenu(expanded, { expanded = false }, items)
    }
}

/** The time alone today and tomorrow, which the group names; the day too after that. */
private fun upcomingTime(milliseconds: Double, kind: UpcomingKind): String =
    if (kind == UpcomingKind.Today || kind == UpcomingKind.Tomorrow) timeOfDay(milliseconds) else dayAndTime(milliseconds)

/** "Arrive at Office · from Mon 9 Nov, 06:00 · until Mon 9 Nov, 12:00" */
fun placeWindow(reminder: Reminder): String? {
    val place = reminder.place ?: return null
    return listOfNotNull(
        place.summary, reminder.notBefore?.let { "from ${dayAndTime(it)}" }, reminder.notAfter?.let { "until ${dayAndTime(it)}" },
    ).joinToString(" · ")
}

/**
 * The suggestions over the composer of the person's Golem. Golem suggests from quiet threads, so they load again when
 * the orchestrator's own work ends.
 */
@Composable
fun Suggestions(running: Boolean?) {
    val session = LocalSession.current
    var suggestions by remember { mutableStateOf<List<Suggestion>>(emptyList()) }
    LaunchedEffect(running, session.workspace?.id) {
        val workspace = session.workspace ?: return@LaunchedEffect
        if (running == true) return@LaunchedEffect
        quietly { session.api.upcoming(workspace.id) }?.let { suggestions = it.suggestions }
    }
    Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(Tokens.Space.sm)) {
        suggestions.forEach { suggestion ->
            androidx.compose.runtime.key(suggestion.id) {
                SuggestionCard(suggestion) { suggestions = suggestions - suggestion }
            }
        }
    }
}

/**
 * A routine, a reminder, or a channel that Golem suggests, with Decline and Accept: a compact row in Upcoming, and a
 * card over the composer of the person's Golem. `answered` takes it away.
 */
@Composable
fun SuggestionCard(suggestion: Suggestion, card: Boolean = true, answered: () -> Unit) {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val kind = when (suggestion.kind) {
        "routine" -> "Routine"
        "reminder" -> "Reminder"
        else -> "Private channel"
    }
    val detail = listOfNotNull(kind, suggestion.time?.let(::dayAndTime) ?: suggestion.schedule).joinToString(" · ")

    fun answer(accept: Boolean) {
        val workspace = session.workspace ?: return
        busy = true
        scope.launch {
            session.run {
                session.api.answerSuggestion(workspace.id, suggestion.id, accept)
                if (accept) {
                    val done = when (suggestion.kind) {
                        "routine" -> "Routine added"
                        "reminder" -> "Reminder set"
                        else -> "Channel added"
                    }
                    session.show(done, dev.golem.api.Toast.Tone.Success)
                    if (suggestion.kind == "channel") session.reloadWorkspace()
                }
                answered()
            }
            busy = false
        }
    }

    Row(
        if (card) Modifier.fillMaxWidth().raisedCard(ring = Golem.colors.ringControl).padding(Tokens.Space.lg)
        else Modifier.fillMaxWidth().heightIn(min = Tokens.Mobile.Size.row).padding(horizontal = Tokens.Mobile.Size.margin),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md),
    ) {
        if (!card) {
            val icon = when (suggestion.kind) {
                "routine" -> Icons.Outlined.Refresh
                "reminder" -> Icons.Outlined.Notifications
                else -> Icons.Outlined.Tag
            }
            Box(Modifier.width(21.dp), contentAlignment = Alignment.Center) {
                Icon(icon, null, Modifier.size(18.dp), tint = Golem.mobile.textSecondary)
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                suggestion.name, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Golem.mobile.text,
                style = golemText(
                    if (card) Tokens.Mobile.FontSize.small else Tokens.Mobile.FontSize.row,
                    if (card) Tokens.FontWeight.medium else Tokens.FontWeight.book,
                ),
            )
            Text(
                detail, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Golem.mobile.textTertiary,
                style = golemText(if (card) Tokens.Mobile.FontSize.caption else Tokens.Mobile.FontSize.small, Tokens.FontWeight.book),
            )
        }
        GolemButton("Decline", { answer(false) }, size = ButtonSize.Small, enabled = !busy)
        GolemButton("Accept", { answer(true) }, variant = ButtonVariant.Primary, size = ButtonSize.Small, enabled = !busy)
    }
}

/** A group of Upcoming, in the order of the kinds. */
enum class UpcomingKind(val title: String) {
    NeedsYou("Needs you"), Suggested("Suggested"), Today("Today"), Tomorrow("Tomorrow"), ThisWeek("This week"),
    Later("Later"), AtPlace("At a place"), RoutinesAtPlace("Routines at a place"), Paused("Paused"),
}

data class UpcomingGroup(val kind: UpcomingKind, val items: List<UpcomingItem>)

sealed interface UpcomingItem {
    val id: String

    data class ApprovalItem(val threadId: String, val approval: Approval) : UpcomingItem {
        override val id get() = "approval:${approval.id}"
    }

    data class RoutineItem(val routine: Routine) : UpcomingItem {
        override val id get() = "routine:${routine.id}"
    }

    data class ReminderItem(val reminder: Reminder) : UpcomingItem {
        override val id get() = "reminder:${reminder.id}"
    }

    data class SuggestionItem(val suggestion: Suggestion) : UpcomingItem {
        override val id get() = "suggestion:${suggestion.id}"
    }
}

/**
 * The groups that have items: approvals and failed routines need the person; routines by their next run and reminders
 * by their time go under the day, soonest first ("This week" is the 5 days after tomorrow); then the reminders that
 * wait for a place, the routines at a place, and the paused routines last.
 */
fun Upcoming.groups(now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): List<UpcomingGroup> {
    val needsYou = approvals.map<_, UpcomingItem> { UpcomingItem.ApprovalItem(it.threadId, it.approval) }.toMutableList()
    val paused = mutableListOf<UpcomingItem>()
    val routinesAtPlace = mutableListOf<UpcomingItem>()
    val timed = reminders.filter { !it.waitsForPlace }.map<_, Pair<Double, UpcomingItem>> { it.dueAt to UpcomingItem.ReminderItem(it) }
        .toMutableList()
    for (routine in routines) {
        when {
            !routine.enabled -> paused += UpcomingItem.RoutineItem(routine)
            routine.lastRun?.outcome == "failed" -> needsYou += UpcomingItem.RoutineItem(routine)
            routine.place != null -> routinesAtPlace += UpcomingItem.RoutineItem(routine)
            else -> timed += (routine.nextRunAt ?: Double.POSITIVE_INFINITY) to UpcomingItem.RoutineItem(routine)
        }
    }
    val items = mutableMapOf<UpcomingKind, MutableList<UpcomingItem>>(
        UpcomingKind.NeedsYou to needsYou,
        UpcomingKind.Suggested to suggestions.map<_, UpcomingItem> { UpcomingItem.SuggestionItem(it) }.toMutableList(),
        UpcomingKind.AtPlace to reminders.filter { it.waitsForPlace }.map<_, UpcomingItem> { UpcomingItem.ReminderItem(it) }.toMutableList(),
        UpcomingKind.RoutinesAtPlace to routinesAtPlace,
        UpcomingKind.Paused to paused,
    )
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().atStartOfDay(zone)
    for ((time, item) in timed.sortedBy { it.first }) {
        val days = if (time.isFinite()) ChronoUnit.DAYS.between(today, Instant.ofEpochMilli(time.toLong()).atZone(zone)) else Long.MAX_VALUE
        val kind = when {
            days < 1 -> UpcomingKind.Today
            days == 1L -> UpcomingKind.Tomorrow
            days < 7 -> UpcomingKind.ThisWeek
            else -> UpcomingKind.Later
        }
        items.getOrPut(kind) { mutableListOf() } += item
    }
    return UpcomingKind.entries.mapNotNull { kind -> items[kind]?.takeIf { it.isNotEmpty() }?.let { UpcomingGroup(kind, it) } }
}
