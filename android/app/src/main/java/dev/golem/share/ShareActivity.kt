package dev.golem.share

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.golem.GolemApp
import dev.golem.api.Topic
import dev.golem.api.ChatSummary
import dev.golem.api.Workspace
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.ButtonSize
import dev.golem.design.ButtonVariant
import dev.golem.design.FileChips
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemMenu
import dev.golem.design.GolemTextField
import dev.golem.design.GolemTheme
import dev.golem.design.MenuAction
import dev.golem.design.SettingsRow
import dev.golem.design.Tokens
import dev.golem.design.golemText
import dev.golem.views.LocalClose
import dev.golem.views.ScreenBar
import dev.golem.views.pickedCopy
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.io.File
import kotlin.math.roundToInt

/** Golem in the share sheet: shows `ShareView` with what was shared, and closes when it is sent or cancelled. */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val text = listOfNotNull(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()?.ifEmpty { null })
        setContent {
            GolemTheme { ShareView(text, streams(intent)) { finish() } }
        }
    }

    /** The files of a share: one for `ACTION_SEND`, several for `ACTION_SEND_MULTIPLE`. */
    private fun streams(intent: Intent): List<Uri> = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
    } else {
        listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
    }
}

/**
 * What was shared, as a message to the workspace's Golem chat or as a new chat in one of its topics. Links and
 * text go in the message, to edit; anything else is a file. It remembers the last workspace and place.
 */
@Composable
private fun ShareView(shared: List<String>, streams: List<Uri>, done: () -> Unit) {
    val context = LocalContext.current
    val api = remember { (context.applicationContext as GolemApp).session.api }
    val preferences = remember { context.getSharedPreferences("share", Context.MODE_PRIVATE) }
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf(shared.joinToString("\n")) }
    var files by remember { mutableStateOf<List<File>>(emptyList()) }
    var workspaces by remember { mutableStateOf<List<Workspace>>(emptyList()) }
    var topics by remember { mutableStateOf<List<Topic>>(emptyList()) }
    var orchestrator by remember { mutableStateOf<ChatSummary?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    /** What was shared is still being copied, such as a long video. */
    var preparing by remember { mutableStateOf(true) }
    /** The share of the upload sent so far, from 0 to 1. */
    var sent by remember { mutableDoubleStateOf(0.0) }
    var workspaceId by remember { mutableStateOf(preferences.getString("workspaceId", "").orEmpty()) }
    /** A topic's id, or empty for the Golem chat. */
    var topicId by remember { mutableStateOf(preferences.getString("topicId", "").orEmpty()) }

    fun finish() {
        files.forEach { it.parentFile?.deleteRecursively() }
        done()
    }
    val canSend = !sending && !preparing && (orchestrator != null || topicId.isNotEmpty()) &&
        (text.isNotBlank() || files.isNotEmpty())

    fun send() {
        sending = true
        sent = 0.0
        failure = null
        preferences.edit().putString("workspaceId", workspaceId).putString("topicId", topicId).apply()
        scope.launch {
            try {
                val golem = orchestrator
                if (topicId.isEmpty() && golem != null) {
                    api.sendMessage(golem.id, text.trim(), files, progress = { sent = it })
                } else {
                    api.createChat(workspaceId, topicId, text.trim(), files, progress = { sent = it })
                }
                finish()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                failure = error.message ?: "Golem did not get it."
                sending = false
            }
        }
    }

    LaunchedEffect(Unit) {
        files = streams.mapNotNull { pickedCopy(context, it) }
        preparing = false
        if (api.token == null) {
            failure = "Sign in to Golem first."
            return@LaunchedEffect
        }
        try {
            workspaces = api.me().workspaces
            if (workspaces.none { it.id == workspaceId }) workspaceId = workspaces.firstOrNull()?.id.orEmpty()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            failure = error.message
        }
    }
    LaunchedEffect(workspaceId) {
        if (workspaceId.isEmpty()) return@LaunchedEffect
        try {
            topics = api.workspace(workspaceId).topics
            orchestrator = api.orchestrator(workspaceId)
            if (topics.none { it.id == topicId }) topicId = ""
            failure = null
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            failure = error.message
        }
    }

    CompositionLocalProvider(LocalClose provides ::finish) {
        Scaffold(
            containerColor = Golem.mobile.background,
            topBar = {
                ScreenBar("Golem") {
                    GolemButton(
                        "Send", ::send, variant = ButtonVariant.Primary, size = ButtonSize.Small, enabled = canSend, busy = sending,
                        modifier = Modifier.padding(end = Tokens.Space.md),
                    )
                }
            },
        ) { padding ->
            Column(
                Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space.md),
            ) {
                Column(
                    Modifier.padding(horizontal = Tokens.Mobile.Size.margin),
                    verticalArrangement = Arrangement.spacedBy(Tokens.Space.md),
                ) {
                    GolemTextField(text, { text = it }, placeholder = "Message", singleLine = false, minLines = 3)
                    if (files.isNotEmpty()) FileChips(files.map { it.name })
                    if (preparing) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm)) {
                            CircularProgressIndicator(Modifier.size(14.dp), color = Golem.mobile.textSecondary, strokeWidth = 1.5.dp)
                            Text("Preparing", style = golemText(Tokens.Mobile.FontSize.small), color = Golem.mobile.textSecondary)
                        }
                    }
                    if (sending) Progress(sent)
                }
                if (workspaces.size > 1) {
                    Choice(
                        "Workspace", workspaces.firstOrNull { it.id == workspaceId }?.name.orEmpty(),
                        workspaces.map { MenuAction(it.name, checked = it.id == workspaceId) { workspaceId = it.id } },
                    )
                }
                Choice(
                    "Send to", topics.firstOrNull { it.id == topicId }?.let { "${it.icon ?: "#"} ${it.name}" } ?: "Golem",
                    listOf(MenuAction("Golem", checked = topicId.isEmpty()) { topicId = "" }) +
                        topics.map { MenuAction("${it.icon ?: "#"} ${it.name}", checked = it.id == topicId) { topicId = it.id } },
                )
                failure?.let {
                    Text(
                        it, style = golemText(Tokens.Mobile.FontSize.small), color = Golem.colors.danger,
                        modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin),
                    )
                }
            }
        }
    }
}

/** The upload's progress bar, with its share in percent. */
@Composable
private fun Progress(sent: Double) {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            val style = golemText(Tokens.Mobile.FontSize.small)
            Text(if (sent < 1) "Uploading" else "Sending", style = style, color = Golem.mobile.textSecondary)
            Text("${(sent * 100).roundToInt()}%", style = style, color = Golem.mobile.textSecondary)
        }
        LinearProgressIndicator(
            progress = { sent.toFloat() }, modifier = Modifier.fillMaxWidth(), color = Golem.colors.accent,
            trackColor = Golem.mobile.fill, drawStopIndicator = {},
        )
    }
}

/** A settings row that picks one of `options` from a menu. */
@Composable
private fun Choice(label: String, value: String, options: List<MenuAction>) {
    var open by remember { mutableStateOf(false) }
    Box {
        SettingsRow(label, onClick = { open = true }) {
            Text(value, style = golemText(Tokens.Mobile.FontSize.row), color = Golem.mobile.textSecondary, maxLines = 1)
            Icon(Pixel.Updown.vector, null, tint = Golem.mobile.textTertiary)
        }
        GolemMenu(open, { open = false }, options)
    }
}
