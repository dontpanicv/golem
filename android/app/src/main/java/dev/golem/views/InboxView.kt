package dev.golem.views

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import dev.golem.api.Destination
import dev.golem.api.InboxNotification
import dev.golem.design.EmptyState
import dev.golem.design.Golem
import dev.golem.design.GolemMark
import dev.golem.design.ListPadding
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.PillBar
import dev.golem.design.Tokens
import dev.golem.design.golemText
import dev.golem.design.pressable
import kotlinx.coroutines.launch

/**
 * The open workspace's notifications, newest first, as Slack's Activity: All or Unread, each with Golem's avatar,
 * where it happened, and a dot while unread. A tap reads one and opens its thread or channel.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxView() {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var unreadOnly by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val unread = session.inbox?.unread ?: 0
    val notifications = session.inbox?.notifications.orEmpty().filter { !unreadOnly || it.readAt == null }

    LaunchedEffect(Unit) { session.run { session.loadInbox() } }

    Scaffold(
        containerColor = Golem.mobile.background,
        topBar = {
            ScreenBar(
                "Activity",
                menu = if (unread > 0) listOf(MenuAction("Mark all read", Icons.Outlined.DoneAll) {
                    session.launch { session.readNotifications(null) }
                }) else emptyList(),
            )
        },
    ) { padding ->
        PullToRefreshBox(
            refreshing, onRefresh = {
                refreshing = true
                scope.launch {
                    session.run { session.loadInbox() }
                    refreshing = false
                }
            },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = ListPadding) {
                item(key = "pills") {
                    PillBar(unreadOnly, listOf(false, true), { if (it) "Unread" else "All" }, { unreadOnly = it },
                        count = { if (it) session.inbox?.unread else null })
                }
                items(notifications, key = { it.id }) { NotificationRow(it, Modifier.animateItem()) }
            }
            if (notifications.isEmpty() && session.inbox != null) {
                EmptyState(if (unreadOnly) "All read" else "No notifications",
                    { Icon(Icons.Outlined.Notifications, null, tint = Golem.colors.textQuaternary) })
            }
        }
    }
}

@Composable
private fun NotificationRow(notification: InboxNotification, modifier: Modifier = Modifier) {
    val session = LocalSession.current
    val open = LocalOpen.current
    val unread = notification.readAt == null
    val channel = session.channels.firstOrNull { it.id == notification.channelId }?.name
    Row(
        modifier.fillMaxWidth()
            .pressable({
                if (unread) session.launch { session.readNotifications(notification.id) }
                open(notification.threadId?.let { Destination.Thread(it) } ?: Destination.Channel(notification.channelId))
            })
            .padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.lg),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space.lg),
    ) {
        GolemMark(Tokens.Mobile.Size.avatar)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Tokens.Space.xxs)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    notification.title, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.semibold),
                    color = Golem.mobile.title, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                // The day, as the web's Inbox writes it.
                Text(shortDay(notification.createdAt), style = golemText(Tokens.Mobile.FontSize.caption),
                    color = Golem.mobile.textQuaternary, modifier = Modifier.padding(start = Tokens.Space.md))
            }
            channel?.let {
                Text("in # $it", style = golemText(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.book),
                    color = Golem.mobile.textTertiary)
            }
            Text(notification.text, style = golemText(Tokens.Mobile.FontSize.small), color = Golem.mobile.textSecondary,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Box(
            Modifier.padding(top = Tokens.Space.sm).size(Tokens.Size.dot * 1.5f)
                .background(if (unread) Golem.colors.accent else Color.Transparent, CircleShape)
                .then(if (unread) Modifier.semantics { contentDescription = "Unread" } else Modifier),
        )
    }
}
