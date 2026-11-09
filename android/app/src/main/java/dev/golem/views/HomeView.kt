package dev.golem.views

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.unit.dp
import dev.golem.api.Channel
import dev.golem.api.Destination
import dev.golem.api.ThreadSummary
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.FoldingSection
import dev.golem.design.Golem
import dev.golem.design.GolemMenu
import dev.golem.design.ListRow
import dev.golem.design.ListSeparator
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.Tokens
import dev.golem.design.golemMono
import dev.golem.design.golemText
import kotlinx.coroutines.launch

/**
 * The open workspace, as Slack's Home: its newest open threads and its channels, in sections that fold. The round
 * button starts a thread or a channel.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeView() {
    val session = LocalSession.current
    val open = LocalOpen.current
    val scope = rememberCoroutineScope()
    var threadsFolded by rememberSaveable { mutableStateOf(false) }
    var allThreads by rememberSaveable { mutableStateOf(false) }
    var channelsFolded by rememberSaveable { mutableStateOf(false) }
    var privateFolded by rememberSaveable { mutableStateOf(false) }
    var newChannel by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val openThreads = session.channels.flatMap { it.threads }.filter { it.settledAt == null }.sortedByDescending { it.updatedAt }
    val privateChannels = session.channels.filter { it.ownerId != null }

    Scaffold(
        containerColor = Golem.mobile.background,
        topBar = { ScreenBar(session.workspace?.name ?: "Home") },
        floatingActionButton = { NewMenu { newChannel = true } },
    ) { padding ->
        PullToRefreshBox(
            refreshing, onRefresh = {
                refreshing = true
                scope.launch {
                    session.run { session.reloadWorkspace() }
                    refreshing = false
                }
            },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = Tokens.Mobile.Size.voice + Tokens.Space.xxl)) {
                if (openThreads.isNotEmpty()) {
                    item {
                        FoldingSection("Threads", threadsFolded, { threadsFolded = it }) {
                            (if (allThreads) openThreads else openThreads.take(3)).forEach { ThreadRow(it) }
                            // Only the newest threads show, so many threads do not push the channels down.
                            if (openThreads.size > 3) {
                                ListRow(
                                    if (allThreads) "Show less" else "Show more",
                                    icon = if (allThreads) Pixel.ChevronUp.vector else Pixel.Chevron.vector,
                                    onClick = { allThreads = !allThreads },
                                )
                            }
                        }
                        ListSeparator()
                    }
                }
                item {
                    FoldingSection("Channels", channelsFolded, { channelsFolded = it }) {
                        session.channels.filter { it.ownerId == null }.forEach { ChannelRow(it) }
                    }
                }
                if (session.owner || privateChannels.isNotEmpty()) {
                    item {
                        ListSeparator()
                        FoldingSection("Private", privateFolded, { privateFolded = it }) {
                            privateChannels.forEach { ChannelRow(it) }
                            if (session.owner) ListRow("Feedback", icon = Pixel.Info.vector, onClick = { open(Destination.Feedback) })
                        }
                    }
                }
            }
        }
    }
    if (newChannel) {
        NewChannelDialog(onDismiss = { newChannel = false }) { name, private ->
            session.createChannel(name, private)?.let { open(Destination.Channel(it.id)) }
        }
    }
}

/** The round accent button over the bar, as Slack's: a new thread in a channel, or a new channel. */
@Composable
private fun NewMenu(newChannel: () -> Unit) {
    val session = LocalSession.current
    val open = LocalOpen.current
    var expanded by remember { mutableStateOf(false) }
    Box {
        FloatingActionButton(
            { expanded = true }, shape = RectangleShape, containerColor = Golem.colors.accent,
            contentColor = Golem.colors.onAccent, modifier = Modifier.size(Tokens.Mobile.Size.voice + 8.dp),
        ) { Icon(Pixel.Plus.vector, "New") }
        GolemMenu(
            expanded, { expanded = false },
            buildList {
                add(MenuAction("New channel", Pixel.Hash.vector, action = newChannel))
                if (session.channels.isNotEmpty()) {
                    add(MenuAction("New thread", Pixel.Compose.vector, children = session.channels.map { channel ->
                        MenuAction("# ${channel.name}") { open(Destination.NewThread(channel.id)) }
                    }))
                }
            },
        )
    }
}

@Composable
private fun ThreadRow(thread: ThreadSummary) {
    val session = LocalSession.current
    val open = LocalOpen.current
    var menu by remember { mutableStateOf(false) }
    Box {
        ListRow(
            thread.title, icon = Pixel.Chat.vector,
            subtitle = session.channels.firstOrNull { it.id == thread.channelId }?.let { "# ${it.name}" },
            working = thread.id in session.working,
            onClick = { open(Destination.Thread(thread.id)) },
            onLongClick = { menu = true },
        )
        GolemMenu(menu, { menu = false }, listOf(
            MenuAction("Settle thread", Pixel.Check.vector) { session.launch { session.setThreadSettled(thread.id, true) } },
        ))
    }
}

@Composable
private fun ChannelRow(channel: Channel) {
    val session = LocalSession.current
    val open = LocalOpen.current
    val openThreads = channel.threads.filter { it.settledAt == null }
    ListRow(
        channel.name, icon = Pixel.Hash.vector, emoji = channel.icon,
        working = openThreads.any { it.id in session.working },
        onClick = { open(Destination.Channel(channel.id)) },
    ) {
        if (channel.ownerId != null) Icon(Pixel.Lock.vector, "Private", tint = Golem.mobile.textQuaternary)
        if (openThreads.isNotEmpty()) {
            Text("${openThreads.size}", style = golemMono(Tokens.Mobile.FontSize.mono, Tokens.FontWeight.medium),
                color = Golem.mobile.textQuaternary)
        }
    }
}

