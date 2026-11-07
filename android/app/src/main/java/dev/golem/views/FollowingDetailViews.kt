package dev.golem.views

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import dev.golem.api.Destination
import dev.golem.api.FollowingDetail
import dev.golem.api.FollowingEvidence
import dev.golem.api.IntakeFeedback
import dev.golem.api.IntakeKept
import dev.golem.api.IntakeSource
import dev.golem.api.IntakeUpdate
import dev.golem.api.changeFollowing
import dev.golem.api.changeUpdate
import dev.golem.api.deleteUpdate
import dev.golem.api.followingDetail
import dev.golem.api.sendFeedback
import dev.golem.design.GolemButton
import dev.golem.design.Golem
import dev.golem.design.GolemTextField
import dev.golem.design.ListRow
import dev.golem.design.ListSectionHeader
import dev.golem.design.ListSeparator
import dev.golem.design.Loading
import dev.golem.design.LocalSession
import dev.golem.design.SettingsRow
import dev.golem.design.Tokens
import dev.golem.design.golemText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** A waiting or done thread update: what Golem will post, its sources, and Send now, Don't send, or Delete and block. */
@Composable
fun UpdateDetailView(update: IntakeUpdate, earlier: List<IntakeFeedback>, open: (Destination) -> Unit, close: () -> Unit) {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf(update) }
    var busy by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    // The sender alone: a block covers all their conversations.
    val senders = update.evidence.filter { !it.fromOwner }.map { it.source.split("; ").getOrNull(2) ?: it.name }.distinct()
        .ifEmpty { listOf("these sources") }.joinToString(", ")

    fun change(action: String) {
        val workspace = session.workspace ?: return
        busy = true
        scope.launch {
            session.run { current = session.api.changeUpdate(workspace.id, update.id, action) }
            busy = false
        }
    }

    IntakeDetail(current.title, "update:${update.id}", earlier, close) {
        SettingsRow(updateState(current), description = current.notice?.let { "Golem will also notify you: $it" })
        DetailText(current.message)
        if (current.waits) {
            if (current.attention == "brief") ActionRow("Send now", Icons.AutoMirrored.Outlined.Send, busy) { change("now") }
            ActionRow("Don't send", Icons.Outlined.Close, busy) { change("cancel") }
            ActionRow("Delete and block", Icons.Outlined.Delete, busy) { confirmDelete = true }
        }
        current.threadId?.let { ActionRow("Open thread", Icons.AutoMirrored.Outlined.Chat) { open(Destination.Thread(it)) } }
        SourcesSection(current.evidence)
    }
    if (confirmDelete) {
        ConfirmDialog(
            "Delete and block?",
            "Golem deletes this update and all it read from $senders, with its files, and reads nothing more from them.",
            "Delete and block", { confirmDelete = false }, danger = true,
        ) {
            val workspace = session.workspace ?: return@ConfirmDialog
            session.api.deleteUpdate(workspace.id, update.id)
            close()
        }
    }
}

/** One observation that intake keeps: when, where it went, its text, its thread, and its source. */
@Composable
fun KeptDetailView(item: IntakeKept, earlier: List<IntakeFeedback>, open: (Destination) -> Unit, close: () -> Unit) {
    IntakeDetail(item.name, "item:${item.id}", earlier, close) {
        SettingsRow(dateAndTime(item.at), description = item.location)
        DetailText(item.text)
        item.threadId?.let { ActionRow("Open thread", Icons.AutoMirrored.Outlined.Chat) { open(Destination.Thread(it)) } }
        SourceLink(item.url)
    }
}

/** One account that Golem reads: how far it read, and its last error. */
@Composable
fun SourceDetailView(source: IntakeSource, earlier: List<IntakeFeedback>, close: () -> Unit) {
    IntakeDetail(source.name, "source:${source.id}", earlier, close) {
        SettingsRow(sourceState(source), description = source.error)
    }
}

/** One followed matter: its state, its actions, its sources and history, and a correction in the person's words. */
@Composable
fun FollowingDetailView(checkId: String, open: (Destination) -> Unit) {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var detail by remember { mutableStateOf<FollowingDetail?>(null) }
    var quote by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    suspend fun load() {
        val workspace = session.workspace ?: return
        detail = session.api.followingDetail(workspace.id, checkId)
    }

    fun change(action: String, words: String) {
        val workspace = session.workspace ?: return
        val check = detail?.check ?: return
        busy = true
        scope.launch {
            session.run {
                try {
                    detail = session.api.changeFollowing(workspace.id, check, action, words)
                    quote = ""
                } catch (error: Exception) {
                    // A check that changed meanwhile shows as it is now.
                    if (error !is CancellationException) quietly { load() }
                    throw error
                }
            }
            busy = false
        }
    }

    LaunchedEffect(checkId) { session.run { load() } }

    val loaded = detail
    if (loaded == null) {
        DetailScreen("Following") { Loading() }
        return
    }
    val check = loaded.check
    DetailScreen("Following") {
        DetailText(check.text)
        when {
            check.explicitTime != 0 -> SettingsRow("Due", description = dateAndTime(check.checkAt))
            check.state == "open" -> SettingsRow("Next look", description = dateAndTime(check.reviewAt))
            else -> SettingsRow(check.stateLabel, description = dateAndTime(check.updatedAt))
        }
        // An action's quote is its own title, as the person's words for the change.
        if (check.state == "open") {
            ActionRow("Handled", Icons.Outlined.Check, busy) { change("handled", "Handled") }
            ActionRow("Stop following", Icons.Outlined.StopCircle, busy) { change("stop", "Stop following") }
        } else {
            ActionRow("Follow again", Icons.Outlined.Refresh, busy) { change("reopen", "Follow again") }
        }
        if (loaded.history.firstOrNull()?.previous != null) {
            ActionRow("Undo last change", Icons.AutoMirrored.Outlined.Undo, busy) { change("undo", "Undo last change") }
        }
        check.threadId?.let { ActionRow("Open thread", Icons.AutoMirrored.Outlined.Chat) { open(Destination.Thread(it)) } }
        SourcesSection(loaded.evidence)
        if (loaded.history.isNotEmpty()) {
            ListSeparator()
            ListSectionHeader("History")
            loaded.history.forEach {
                SettingsRow(it.quote ?: "Golem review", description = "${dateAndTime(it.at)} · ${it.current.text}")
            }
        }
        ListSeparator()
        ListSectionHeader("Correction")
        QuoteField(
            quote, { quote = it }, "What is still open, or what is wrong?", if (busy) "Saving…" else "Correct",
            enabled = !busy && quote.isNotBlank() && quote.length <= 8000,
        ) { change("correct", quote) }
    }
}

/** The detail of one thing that intake holds, then the person's earlier feedback on it and a field for more. */
@Composable
private fun IntakeDetail(
    title: String, target: String, earlier: List<IntakeFeedback>, close: () -> Unit, content: @Composable ColumnScope.() -> Unit,
) {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var quote by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    DetailScreen(title) {
        content()
        ListSeparator()
        ListSectionHeader("Feedback")
        earlier.forEach { SettingsRow(it.quote, description = "You said ${dateAndTime(it.createdAt)}") }
        QuoteField(
            quote, { quote = it }, "What should Golem do differently?", if (busy) "Sending…" else "Send feedback",
            enabled = !busy && quote.isNotBlank(),
        ) {
            val workspace = session.workspace ?: return@QuoteField
            busy = true
            scope.launch {
                session.run {
                    session.api.sendFeedback(workspace.id, target, quote)
                    close()
                }
                busy = false
            }
        }
    }
}

/** A screen over Following, with the close button at the top and its content in one scroll. */
@Composable
private fun DetailScreen(title: String, content: @Composable ColumnScope.() -> Unit) {
    Scaffold(containerColor = Golem.mobile.background, topBar = { ScreenBar(title) }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().imePadding().verticalScroll(rememberScrollState())
                .padding(bottom = Tokens.Space.xxxl),
            content = content,
        )
    }
}

/** A field for the person's words, and its button. */
@Composable
private fun QuoteField(value: String, onChange: (String) -> Unit, placeholder: String, action: String, enabled: Boolean, send: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md),
        verticalArrangement = Arrangement.spacedBy(Tokens.Space.md),
    ) {
        GolemTextField(value, onChange, placeholder = placeholder, singleLine = false, minLines = 3)
        GolemButton(action, send, enabled = enabled)
    }
}

@Composable
private fun ActionRow(title: String, icon: ImageVector, busy: Boolean = false, action: () -> Unit) {
    ListRow(title, icon = icon, onClick = if (busy) null else action)
}

/** The source observations behind an update or a check, each opened in place. */
@Composable
private fun SourcesSection(evidence: List<FollowingEvidence>) {
    if (evidence.isEmpty()) return
    ListSeparator()
    ListSectionHeader("Sources")
    evidence.forEach { each ->
        var expanded by remember(each.id) { mutableStateOf(false) }
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }.heightIn(min = Tokens.Size.listRow)
                .padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("${each.name} · ${dateAndTime(each.at)}", style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book),
                color = Golem.mobile.text, modifier = Modifier.weight(1f))
            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (expanded) "Fold" else "Open",
                Modifier.size(18.dp), tint = Golem.mobile.textQuaternary)
        }
        if (expanded) {
            DetailText(each.text)
            each.attachments.forEach {
                Text(it.name, style = golemText(Tokens.Mobile.FontSize.small), color = Golem.mobile.textTertiary,
                    modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin))
            }
            SourceLink(each.url)
        }
    }
}

@Composable
private fun DetailText(text: String) {
    SelectionContainer {
        Text(text, style = golemText(Tokens.Mobile.FontSize.row), color = Golem.mobile.text,
            modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md))
    }
}

/** Opens a source's https address in the browser; other addresses do not open. */
@Composable
private fun SourceLink(url: String?) {
    val uri = LocalUriHandler.current
    if (url == null || !url.startsWith("https://")) return
    ActionRow("Open source", Icons.AutoMirrored.Outlined.OpenInNew) { runCatching { uri.openUri(url) } }
}
