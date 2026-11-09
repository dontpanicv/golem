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
import dev.golem.api.Topic
import dev.golem.api.Destination
import dev.golem.api.ChatSummary
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
 * The open workspace, as Slack's Home: its newest open chats and its topics, in sections that fold. The round
 * button starts a chat or a topic.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeView() {
    val session = LocalSession.current
    val open = LocalOpen.current
    val scope = rememberCoroutineScope()
    var chatsFolded by rememberSaveable { mutableStateOf(false) }
    var allChats by rememberSaveable { mutableStateOf(false) }
    var topicsFolded by rememberSaveable { mutableStateOf(false) }
    var privateFolded by rememberSaveable { mutableStateOf(false) }
    var newTopic by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val openChats = session.topics.flatMap { it.chats }.filter { it.settledAt == null }.sortedByDescending { it.updatedAt }
    val privateTopics = session.topics.filter { it.ownerId != null }

    Scaffold(
        containerColor = Golem.mobile.background,
        topBar = { ScreenBar(session.workspace?.name ?: "Home") },
        floatingActionButton = { NewMenu { newTopic = true } },
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
                if (openChats.isNotEmpty()) {
                    item {
                        FoldingSection("Chats", chatsFolded, { chatsFolded = it }) {
                            (if (allChats) openChats else openChats.take(3)).forEach { ChatRow(it) }
                            // Only the newest chats show, so many chats do not push the topics down.
                            if (openChats.size > 3) {
                                ListRow(
                                    if (allChats) "Show less" else "Show more",
                                    icon = if (allChats) Pixel.ChevronUp.vector else Pixel.Chevron.vector,
                                    onClick = { allChats = !allChats },
                                )
                            }
                        }
                        ListSeparator()
                    }
                }
                item {
                    FoldingSection("Topics", topicsFolded, { topicsFolded = it }) {
                        session.topics.filter { it.ownerId == null }.forEach { TopicRow(it) }
                    }
                }
                if (session.owner || privateTopics.isNotEmpty()) {
                    item {
                        ListSeparator()
                        FoldingSection("Private", privateFolded, { privateFolded = it }) {
                            privateTopics.forEach { TopicRow(it) }
                            if (session.owner) ListRow("Feedback", icon = Pixel.Info.vector, onClick = { open(Destination.Feedback) })
                        }
                    }
                }
            }
        }
    }
    if (newTopic) {
        NewTopicDialog(onDismiss = { newTopic = false }) { name, private ->
            session.createTopic(name, private)?.let { open(Destination.Topic(it.id)) }
        }
    }
}

/** The round accent button over the bar, as Slack's: a new chat in a topic, or a new topic. */
@Composable
private fun NewMenu(newTopic: () -> Unit) {
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
                add(MenuAction("New topic", Pixel.Hash.vector, action = newTopic))
                if (session.topics.isNotEmpty()) {
                    add(MenuAction("New chat", Pixel.Compose.vector, children = session.topics.map { topic ->
                        MenuAction("# ${topic.name}") { open(Destination.NewChat(topic.id)) }
                    }))
                }
            },
        )
    }
}

@Composable
private fun ChatRow(chat: ChatSummary) {
    val session = LocalSession.current
    val open = LocalOpen.current
    var menu by remember { mutableStateOf(false) }
    Box {
        ListRow(
            chat.title, icon = Pixel.Chat.vector,
            subtitle = session.topics.firstOrNull { it.id == chat.topicId }?.let { "# ${it.name}" },
            working = chat.id in session.working,
            onClick = { open(Destination.Chat(chat.id)) },
            onLongClick = { menu = true },
        )
        GolemMenu(menu, { menu = false }, listOf(
            MenuAction("Settle chat", Pixel.Check.vector) { session.launch { session.setChatSettled(chat.id, true) } },
        ))
    }
}

@Composable
private fun TopicRow(topic: Topic) {
    val session = LocalSession.current
    val open = LocalOpen.current
    val openChats = topic.chats.filter { it.settledAt == null }
    ListRow(
        topic.name, icon = Pixel.Hash.vector, emoji = topic.icon,
        working = openChats.any { it.id in session.working },
        onClick = { open(Destination.Topic(topic.id)) },
    ) {
        if (topic.ownerId != null) Icon(Pixel.Lock.vector, "Private", tint = Golem.mobile.textQuaternary)
        if (openChats.isNotEmpty()) {
            Text("${openChats.size}", style = golemMono(Tokens.Mobile.FontSize.mono, Tokens.FontWeight.medium),
                color = Golem.mobile.textQuaternary)
        }
    }
}

