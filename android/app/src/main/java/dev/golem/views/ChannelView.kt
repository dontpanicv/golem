package dev.golem.views

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.CallMerge
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import android.text.format.DateUtils
import dev.golem.api.Channel
import dev.golem.api.Destination
import dev.golem.api.ThreadSummary
import dev.golem.design.EmptyState
import dev.golem.design.FoldingSection
import dev.golem.design.Golem
import dev.golem.design.GolemGlyph
import dev.golem.design.GolemMenu
import dev.golem.design.ListSeparator
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.Tokens
import dev.golem.design.WorkingLabel
import dev.golem.design.golemText
import dev.golem.design.pressable
import kotlinx.coroutines.launch
import java.io.File

/**
 * One channel, as a Slack channel: its threads as messages, the newest at the bottom over the composer, and the
 * settled ones folded above them. Sending from the composer starts a new thread. The title holds the channel's menu.
 */
@Composable
fun ChannelView(channelId: String, compose: Boolean = false, artifactId: String? = null) {
    val session = LocalSession.current
    val open = LocalOpen.current
    val back = androidx.activity.compose.LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val scope = rememberCoroutineScope()
    val channel = session.channels.firstOrNull { it.id == channelId }
    var draft by rememberSaveable(channelId) { mutableStateOf("") }
    var files by remember { mutableStateOf<List<File>>(emptyList()) }
    var sending by remember { mutableStateOf(false) }
    var settledFolded by rememberSaveable { mutableStateOf(true) }
    var panel by remember { mutableStateOf(artifactId != null) }
    var mergeInto by remember { mutableStateOf<Channel?>(null) }
    val active = channel?.threads.orEmpty().filter { it.settledAt == null }.sortedBy { it.updatedAt }
    val settled = channel?.threads.orEmpty().filter { it.settledAt != null }.sortedByDescending { it.settledAt }
    // A channel that every member sees merges only into another such channel.
    val mergeTargets = session.channels.filter { it.id != channelId && (channel?.ownerId != null || it.ownerId == null) }

    LaunchedEffect(Unit) { session.run { session.reloadWorkspace() } }

    fun send() {
        val text = draft.trim()
        if ((text.isEmpty() && files.isEmpty()) || sending) return
        sending = true
        scope.launch {
            session.run {
                session.createThread(channelId, text, files)?.let { thread ->
                    draft = ""
                    files = emptyList()
                    open(Destination.Thread(thread.id))
                }
            }
            sending = false
        }
    }

    Scaffold(
        containerColor = Golem.mobile.background,
        topBar = {
            ScreenBar(
                "# ${channel?.name ?: ""}", caption = if (active.size == 1) "1 open thread" else "${active.size} open threads",
                menu = buildList {
                    add(MenuAction("Files and artifacts", Icons.Outlined.FolderOpen) { panel = true })
                    add(MenuAction("Channel details", Icons.Outlined.Info) { open(Destination.ChannelDetails(channelId)) })
                    if (mergeTargets.isNotEmpty()) {
                        add(MenuAction("Merge into", Icons.AutoMirrored.Outlined.CallMerge, children = mergeTargets.map { target ->
                            MenuAction("# ${target.name}") { mergeInto = target }
                        }))
                    }
                },
            )
        },
        bottomBar = {
            ComposerRow {
                Composer(
                    owner = channelId, placeholder = "Message #${channel?.name ?: ""}", draft = draft, onDraft = { draft = it },
                    files = files, onFiles = { files = it }, sending = sending, send = ::send, autofocus = compose,
                )
            }
        },
    ) { padding ->
        if (channel?.threads.isNullOrEmpty()) {
            EmptyState("Ask Golem anything", { GolemGlyph(24.dp, Golem.colors.textQuaternary) }, Modifier.padding(padding))
        } else {
            // The newest thread sits at the bottom over the composer.
            val list = rememberLazyListState()
            val focus = LocalFocusManager.current
            LaunchedEffect(active.size) { if (list.firstVisibleItemIndex <= 2) list.animateScrollToItem(0) }
            LazyColumn(
                Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures { focus.clearFocus() } }, state = list, reverseLayout = true,
                contentPadding = PaddingValues(top = padding.calculateTopPadding() + Tokens.Space.md,
                    bottom = padding.calculateBottomPadding() + Tokens.Space.md),
            ) {
                items(active.reversed(), key = { it.id }) { ThreadRow(it, Modifier.animateItem()) }
                if (settled.isNotEmpty()) {
                    item(key = "settled") {
                        Column {
                            FoldingSection("Settled · ${settled.size}", settledFolded, { settledFolded = it }) {
                                settled.forEach { ThreadRow(it) }
                            }
                            ListSeparator()
                        }
                    }
                }
            }
        }
    }
    if (panel) ArtifactsPanel(channelId, 0, artifactId) { panel = false }
    mergeInto?.let { target ->
        ConfirmDialog(
            "Merge #${channel?.name ?: ""} into #${target.name}?", "Its threads, files, artifacts, and routines move there.",
            "Merge", onDismiss = { mergeInto = null },
        ) {
            session.mergeChannel(channelId, target.id)
            // The merged channel is gone: it leaves the tab's stack, and the other channel opens.
            back?.onBackPressed()
            open(Destination.Channel(target.id))
        }
    }
}

/** A thread as Slack shows a message with replies: its title, then a link to it in the accent, or Golem at work. */
@Composable
private fun ThreadRow(thread: ThreadSummary, modifier: Modifier = Modifier) {
    val session = LocalSession.current
    val open = LocalOpen.current
    var menu by remember { mutableStateOf(false) }
    val isSettled = thread.settledAt != null
    Box(modifier) {
        Row(
            Modifier.fillMaxWidth().pressable({ open(Destination.Thread(thread.id)) }, { menu = true })
                .padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space.lg),
        ) {
            Box(
                Modifier.size(Tokens.Mobile.Size.avatar).clip(RoundedCornerShape(Tokens.Radius.lg)).background(Golem.mobile.fill),
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (isSettled) Icons.Outlined.Check else Icons.AutoMirrored.Outlined.Chat, null, Modifier.size(17.dp),
                    tint = Golem.mobile.textSecondary)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
                Text(thread.title, style = golemText(Tokens.Mobile.FontSize.body), color = Golem.mobile.text, maxLines = 3,
                    overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm), verticalAlignment = Alignment.CenterVertically) {
                    if (thread.id in session.working) {
                        WorkingLabel()
                    } else {
                        Text("View thread", style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium), color = Golem.colors.accent)
                    }
                    Text(relative(thread.updatedAt), style = golemText(Tokens.Mobile.FontSize.small), color = Golem.mobile.textQuaternary)
                }
            }
        }
        GolemMenu(menu, { menu = false }, listOf(
            MenuAction(if (isSettled) "Un-settle thread" else "Settle thread", if (isSettled) Icons.Outlined.Inbox else Icons.Outlined.Check) {
                session.launch { session.setThreadSettled(thread.id, !isSettled) }
            },
        ))
    }
}

/** A time as "5 minutes ago" or "yesterday", as the phone's own apps write it. */
fun relative(milliseconds: Double): String =
    DateUtils.getRelativeTimeSpanString(milliseconds.toLong(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
