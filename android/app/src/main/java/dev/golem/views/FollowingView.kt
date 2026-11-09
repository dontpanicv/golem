package dev.golem.views

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dev.golem.api.Destination
import dev.golem.api.FollowingCheck
import dev.golem.api.FollowingOverview
import dev.golem.api.IntakeBlock
import dev.golem.api.IntakeKept
import dev.golem.api.IntakeSource
import dev.golem.api.IntakeUpdate
import dev.golem.api.following
import dev.golem.api.followingOverview
import dev.golem.api.unblock
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.Badge
import dev.golem.design.EmptyState
import dev.golem.design.FullScreen
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemTextField
import dev.golem.design.ListPadding
import dev.golem.design.ListRow
import dev.golem.design.ListSectionHeader
import dev.golem.design.ListSeparator
import dev.golem.design.LocalSession
import dev.golem.design.Tokens
import dev.golem.design.Tone
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One row of Following, which opens its detail. */
sealed interface Selected {
    val id: String

    data class Check(val check: FollowingCheck) : Selected {
        override val id get() = "check:${check.id}"
    }

    data class Update(val update: IntakeUpdate) : Selected {
        override val id get() = "update:${update.id}"
    }

    data class Kept(val item: IntakeKept) : Selected {
        override val id get() = "item:${item.id}"
    }

    data class Source(val source: IntakeSource) : Selected {
        override val id get() = "source:${source.id}"
    }
}

/** The kept observations that show before "Show all". */
private const val KEPT_ROWS = 15

/**
 * All that Golem holds for the person from the accounts it reads: the chat updates that wait, the matters it
 * follows, its sources, what it keeps, and what it did. Each row opens its detail, where the person gives feedback.
 * It loads again every 30 seconds while it shows, as no stream sends these changes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FollowingList(header: @Composable () -> Unit) {
    val session = LocalSession.current
    val open = LocalOpen.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var checks by remember { mutableStateOf<List<FollowingCheck>?>(null) }
    var overview by remember { mutableStateOf<FollowingOverview?>(null) }
    var query by remember { mutableStateOf("") }
    var allKept by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<Selected?>(null) }
    var unblocking by remember { mutableStateOf<IntakeBlock?>(null) }
    var refreshing by remember { mutableStateOf(false) }

    suspend fun load() {
        val workspace = session.workspace ?: return
        coroutineScope {
            val loadedChecks = async { session.api.following(workspace.id) }
            val loadedOverview = async { session.api.followingOverview(workspace.id, query) }
            checks = loadedChecks.await()
            overview = loadedOverview.await()
        }
    }

    LaunchedEffect(lifecycle, query) {
        if (query.isNotEmpty()) delay(300)
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                session.run { load() }
                delay(30_000)
            }
        }
    }

    val updates = overview?.updates.orEmpty()
    val waiting = updates.filter { it.waits }
    val following = checks.orEmpty().filter { it.state == "open" }
    val done = (updates.filter { !it.waits }.map { (it.deliveredAt ?: it.cancelledAt ?: it.createdAt) to Selected.Update(it) } +
        checks.orEmpty().filter { it.state != "open" }.map { it.updatedAt to Selected.Check(it) })
        .sortedByDescending { it.first }.map { it.second }

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
                section("Waiting", waiting.map { Selected.Update(it) }) { selected = it }
                section("Following", following.map { Selected.Check(it) }) { selected = it }
                section("Sources", overview?.sources.orEmpty().map { Selected.Source(it) }) { selected = it }
                val blocked = overview?.blocked.orEmpty()
                if (blocked.isNotEmpty()) {
                    item(key = "blocked") {
                        ListSeparator()
                        ListSectionHeader("Blocked")
                    }
                    items(blocked, key = { "block:${it.id}" }) { block ->
                        ListRow(block.label, icon = Pixel.Blocked.vector, subtitle = if (block.kind == "sender") "Sender" else "Chat",
                            onClick = { unblocking = block })
                    }
                }
                overview?.takeIf { it.sources.isNotEmpty() }?.let { loaded ->
                    item(key = "kept") {
                        ListSeparator()
                        ListSectionHeader("Kept")
                        GolemTextField(
                            query, { query = it }, placeholder = "Search mail, messages, and notes",
                            modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md),
                        )
                    }
                    items(if (allKept) loaded.kept else loaded.kept.take(KEPT_ROWS), key = { "item:${it.id}" }) { item ->
                        FollowingRowView(Selected.Kept(item)) { selected = it }
                    }
                    if (!allKept && loaded.kept.size > KEPT_ROWS) {
                        item(key = "all") {
                            Box(Modifier.padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md)) {
                                GolemButton("Show all ${loaded.kept.size}", { allKept = true })
                            }
                        }
                    }
                }
                section("Done", done) { selected = it }
                val feedback = overview?.feedback.orEmpty()
                if (feedback.isNotEmpty()) {
                    item(key = "feedback") {
                        ListSeparator()
                        ListSectionHeader("Your feedback")
                    }
                    items(feedback, key = { "feedback:${it.id}" }) {
                        ListRow(it.quote, icon = Pixel.Chat.vector, subtitle = it.about)
                    }
                }
            }
            if (overview?.sources?.isEmpty() == true) {
                EmptyState("Golem reads no account for you")
            }
        }
    }

    unblocking?.let { block ->
        ConfirmDialog("Unblock ${block.label}?", "Golem reads new messages from it again.", "Unblock", { unblocking = null }) {
            val workspace = session.workspace ?: return@ConfirmDialog
            session.api.unblock(workspace.id, block.id)
            load()
        }
    }

    selected?.let { selection ->
        fun close() {
            selected = null
            scope.launch { session.run { load() } }
        }
        val leave: (Destination) -> Unit = { destination ->
            close()
            open(destination)
        }
        val earlier = overview?.feedback.orEmpty().filter { it.target == selection.id }
        BackHandler { close() }
        FullScreen {
            CompositionLocalProvider(LocalClose provides ::close) {
                when (selection) {
                    is Selected.Check -> FollowingDetailView(selection.check.id, leave)
                    is Selected.Update -> UpdateDetailView(selection.update, earlier, leave, ::close)
                    is Selected.Kept -> KeptDetailView(selection.item, earlier, leave, ::close)
                    is Selected.Source -> SourceDetailView(selection.source, earlier, ::close)
                }
            }
        }
    }
}

private fun LazyListScope.section(title: String, rows: List<Selected>, select: (Selected) -> Unit) {
    if (rows.isEmpty()) return
    item(key = "section:$title") {
        ListSeparator()
        ListSectionHeader(title)
    }
    items(rows, key = { "$title:${it.id}" }) { FollowingRowView(it, select) }
}

@Composable
private fun FollowingRowView(row: Selected, select: (Selected) -> Unit) {
    when (row) {
        is Selected.Update -> ListRow(
            row.update.title, icon = if (row.update.deliveredAt == null) Pixel.Clock.vector else Pixel.Check.vector,
            subtitle = "${updateState(row.update)} · ${row.update.message}", onClick = { select(row) },
        )
        is Selected.Check -> ListRow(
            row.check.text, icon = if (row.check.state == "open") Pixel.Eye.vector else Pixel.Check.vector,
            subtitle = checkState(row.check), onClick = { select(row) },
        )
        is Selected.Source -> ListRow(
            row.source.name, icon = Pixel.Inbox.vector, subtitle = row.source.error ?: sourceState(row.source),
            onClick = { select(row) },
        ) {
            if (row.source.error != null) Badge("Error", Tone.Danger)
        }
        is Selected.Kept -> ListRow(
            row.item.name, icon = if (row.item.fromOwner) Pixel.Send.vector else Pixel.Inbox.vector,
            subtitle = "${dateAndTime(row.item.at)} · ${row.item.text}", onClick = { select(row) },
        ) {
            Badge(row.item.badge, if (row.item.outcome == "context") Tone.Neutral else Tone.Success)
        }
    }
}

fun updateState(update: IntakeUpdate): String = when {
    update.deliveredAt != null -> "Posted ${dateAndTime(update.deliveredAt)}"
    update.cancelledAt != null -> "Not sent · ${dateAndTime(update.cancelledAt)}"
    update.attention == "brief" -> "Waits for the 08:00 review"
    else -> "Posts within a minute"
}

fun sourceState(source: IntakeSource): String =
    "${source.readAt?.let { "Read until ${dateAndTime(it)}" } ?: "Not read yet"} · ${source.kept} kept"

private fun checkState(check: FollowingCheck): String = when {
    check.state != "open" -> "${check.stateLabel} · ${dateAndTime(check.updatedAt)}"
    check.explicitTime != 0 -> "Due ${dateAndTime(check.checkAt)}"
    else -> "Next look ${dateAndTime(check.reviewAt)}"
}

