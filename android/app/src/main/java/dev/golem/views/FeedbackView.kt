package dev.golem.views

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.unit.dp
import dev.golem.api.Destination
import dev.golem.api.Feedback
import dev.golem.api.dismissFeedback
import dev.golem.api.feedback
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.EmptyState
import dev.golem.design.Golem
import dev.golem.design.ListPadding
import dev.golem.design.LocalSession
import dev.golem.design.Tokens
import dev.golem.design.golemText
import dev.golem.design.pressable
import kotlinx.coroutines.launch

/**
 * What the agents reported about Golem, newest first, for the server's owner: a tap opens the report's thread when
 * the owner sees it; the check dismisses it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedbackView() {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var reports by remember { mutableStateOf<List<Feedback>?>(null) }
    var refreshing by remember { mutableStateOf(false) }

    suspend fun load() {
        val workspace = session.workspace ?: return
        reports = session.api.feedback(workspace.id)
    }

    LaunchedEffect(Unit) { session.run { load() } }

    Scaffold(containerColor = Golem.mobile.background, topBar = { ScreenBar("Feedback") }) { padding ->
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
                items(reports.orEmpty(), key = { it.id }) { report ->
                    FeedbackRow(report, Modifier.animateItem()) {
                        val workspace = session.workspace ?: return@FeedbackRow
                        session.launch {
                            session.api.dismissFeedback(workspace.id, report.id)
                            reports = reports?.filter { it.id != report.id }
                        }
                    }
                }
            }
            if (reports?.isEmpty() == true) {
                EmptyState("No feedback")
            }
        }
    }
}

@Composable
private fun FeedbackRow(feedback: Feedback, modifier: Modifier = Modifier, dismiss: () -> Unit) {
    val open = LocalOpen.current
    val (label, icon) = when (feedback.kind) {
        "error" -> "Error" to Pixel.Info.vector
        "missing" -> "Missing" to Pixel.Plus.vector
        else -> "Better way" to Pixel.Forward.vector
    }
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Row(
            Modifier.weight(1f)
                .then(feedback.threadId?.let { thread -> Modifier.pressable({ open(Destination.Thread(thread)) }) } ?: Modifier.alpha(0.6f))
                .padding(start = Tokens.Mobile.Size.margin, top = Tokens.Space.lg, bottom = Tokens.Space.lg),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md),
        ) {
            Box(Modifier.width(21.dp), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = Golem.mobile.textSecondary)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Tokens.Space.xxs)) {
                Text(feedback.summary, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.medium), color = Golem.mobile.title)
                Text(listOfNotNull(label, feedback.tool).joinToString(" · "),
                    style = golemText(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.book), color = Golem.mobile.textTertiary)
                Text(feedback.detail, style = golemText(Tokens.Mobile.FontSize.small), color = Golem.mobile.textSecondary)
            }
            // The day, as the web's Feedback writes it.
            Text(shortDay(feedback.createdAt), style = golemText(Tokens.Mobile.FontSize.caption), color = Golem.mobile.textQuaternary)
        }
        IconButton(dismiss, Modifier.padding(horizontal = Tokens.Space.sm, vertical = Tokens.Space.xs)) {
            Icon(Pixel.Check.vector, "Dismiss", tint = Golem.mobile.textTertiary)
        }
    }
}
