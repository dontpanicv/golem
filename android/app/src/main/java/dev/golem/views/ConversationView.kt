package dev.golem.views

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dev.golem.api.Approval
import dev.golem.api.Destination
import dev.golem.api.FileRef
import dev.golem.api.Message
import dev.golem.api.Session
import dev.golem.api.ChatState
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.ButtonSize
import dev.golem.design.ButtonVariant
import dev.golem.design.Dither
import dev.golem.design.DitherView
import dev.golem.design.EmptyState
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemGlyph
import dev.golem.design.GolemMark
import dev.golem.design.LocalSession
import dev.golem.design.Loading
import dev.golem.design.MenuAction
import dev.golem.design.Tokens
import dev.golem.design.golemText
import dev.golem.design.raisedCard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/**
 * One chat, as a Slack thread: messages with their author's avatar, the approvals after them, and the title with the
 * chat's menu. Loads its state, then follows the server-sent events while the screen shows.
 */
@Composable
fun ConversationView(chatId: String, artifactId: String? = null) {
    val session = LocalSession.current
    val open = LocalOpen.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    var state by remember(chatId) { mutableStateOf<ChatState?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var draft by rememberSaveable(chatId) { mutableStateOf("") }
    var files by remember { mutableStateOf<List<File>>(emptyList()) }
    var sending by remember { mutableStateOf(false) }
    var panel by remember { mutableStateOf(artifactId != null) }
    var linkedArtifact by remember { mutableStateOf(artifactId) }
    val orchestrator = chatId == session.orchestrator?.id
    val chat = state?.chat
    val topicName = session.topics.firstOrNull { it.id == chat?.topicId }?.name ?: ""
    val approvals = state?.approvals.orEmpty().filter { it.approverId == null || it.approverId == session.user?.id }
    val working = state?.messages?.lastOrNull { it.streaming || (it.work != null && it.work.endedAt == null) }
    val opener = rememberFileOpener()

    // In the background the stream closes, so Golem keeps this chat's notifications unread.
    LaunchedEffect(chatId) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            session.chatOnScreen = chatId
            try {
                follow(session, chatId, { state = it; failure = null }, { failure = it })
            } finally {
                if (session.chatOnScreen == chatId) session.chatOnScreen = null
            }
        }
    }

    fun send() {
        val text = draft.trim()
        if ((text.isEmpty() && files.isEmpty()) || sending) return
        sending = true
        scope.launch {
            session.run {
                session.api.sendMessage(chatId, text, files)
                draft = ""
                files = emptyList()
            }
            sending = false
        }
    }

    val menu = buildList {
        add(MenuAction("Files and artifacts", Pixel.Folder.vector) { panel = true })
        if (!orchestrator && chat != null) {
            add(MenuAction("Open #$topicName", Pixel.Hash.vector) { open(Destination.Topic(chat.topicId)) })
            add(MenuAction("Move to", Pixel.Right.vector, children = session.topics.filter { it.id != chat.topicId }.map { topic ->
                MenuAction(topic.name, if (topic.ownerId == null) Pixel.Hash.vector else Pixel.Lock.vector) {
                    session.launch { session.moveChat(chatId, topic.id) }
                }
            }))
            val settled = chat.settledAt != null
            add(MenuAction(if (settled) "Un-settle chat" else "Settle chat", if (settled) Pixel.Inbox.vector else Pixel.Check.vector) {
                session.launch { session.setChatSettled(chatId, !settled) }
            })
        }
    }

    // Golem's links in messages open here instead of leaving the app.
    val system = LocalUriHandler.current
    val links = remember(system) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val scheme = uri.substringBefore(':')
                val id = uri.substringAfter(':')
                when (scheme) {
                    "chat" -> open(Destination.Chat(id))
                    // The server names the file when it sends it.
                    "file" -> opener(FileRef(id, ""))
                    "artifact" -> {
                        linkedArtifact = id
                        panel = true
                    }
                    else -> runCatching { system.openUri(uri) }
                }
            }
        }
    }

    Scaffold(
        containerColor = Golem.mobile.background,
        topBar = {
            if (orchestrator) {
                ScreenBar("Golem", caption = if (state?.running == true) "Working" else null, menu = menu,
                    leading = { GolemMark(28.dp) })
            } else {
                ScreenBar(chat?.title ?: "", caption = topicName.takeIf { it.isNotEmpty() }?.let { "# $it" }, menu = menu)
            }
        },
        bottomBar = {
            ComposerRow {
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space.sm)) {
                    if (orchestrator) Suggestions(state?.running)
                    Composer(
                        owner = chatId, placeholder = if (orchestrator) "Message Golem" else "Reply",
                        draft = draft, onDraft = { draft = it }, files = files, onFiles = { files = it },
                        sending = sending, send = ::send,
                        stop = if (state?.running == true) ({ session.launch { session.api.stopChat(chatId) } }) else null,
                    )
                }
            }
        },
    ) { padding ->
        CompositionLocalProvider(LocalUriHandler provides links) {
            val current = state
            when {
                current == null && failure != null -> EmptyState(failure!!)
                current == null -> Loading()
                current.messages.isEmpty() -> EmptyState("Ask Golem anything", { GolemGlyph(24.dp, Golem.colors.textQuaternary) },
                    Modifier.padding(padding))
                else -> Messages(current, approvals, working, chatId, padding, opener)
            }
        }
    }
    if (panel) {
        ArtifactsPanel(
            topicId = if (orchestrator) null else chat?.topicId, changes = state?.messages?.size ?: 0,
            artifactId = linkedArtifact, onDismiss = { panel = false; linkedArtifact = null },
        )
    }
}

/** The messages, the newest at the bottom over the composer, with the approvals in line with the answer that asks. */
@Composable
private fun Messages(
    state: ChatState, approvals: List<Approval>, working: Message?, chatId: String, padding: PaddingValues,
    openFile: (FileRef) -> Unit,
) {
    val messages = state.messages
    val list = rememberLazyListState()
    val focus = LocalFocusManager.current
    // The list starts at its end, and new messages and approvals keep the newest in view while the person is there.
    LaunchedEffect(messages.size, approvals.size) { if (list.firstVisibleItemIndex <= 2) list.animateScrollToItem(0) }
    Box {
    LazyColumn(
        Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures { focus.clearFocus() } }, state = list, reverseLayout = true,
        contentPadding = PaddingValues(
            start = Tokens.Mobile.Size.margin, end = Tokens.Mobile.Size.margin,
            top = padding.calculateTopPadding() + Tokens.Space.md, bottom = padding.calculateBottomPadding() + Tokens.Space.md,
        ),
    ) {
        items(approvals.reversed(), key = { "approval:${it.id}" }) { approval ->
            ApprovalCard(approval, chatId, Modifier.padding(start = Tokens.Mobile.Size.avatar + Tokens.Space.lg, top = Tokens.Space.md).animateItem())
        }
        items(messages.indices.reversed().toList(), key = { messages[it].id }) { index ->
            val message = messages[index]
            val continued = index > 0 && continues(message, messages[index - 1])
            Box(Modifier.padding(top = if (continued) Tokens.Space.xs else Tokens.Space.lg).animateItem()) {
                MessageRow(message, continued, waiting = message.id == working?.id && approvals.isNotEmpty(), openFile = openFile)
            }
        }
    }
    // Messages dissolve at both ends of the transcript, as on the web.
    DitherView(Dither.FadeTop, Golem.mobile.background, Modifier.align(Alignment.TopCenter).padding(top = padding.calculateTopPadding()).fillMaxWidth().height(28.dp))
    DitherView(Dither.FadeBottom, Golem.mobile.background, Modifier.align(Alignment.BottomCenter).padding(bottom = padding.calculateBottomPadding()).fillMaxWidth().height(56.dp))
    }
}

/** Reloads the chat and reads its events again after each error, with a backoff of 1 to 16 seconds. */
private suspend fun follow(session: Session, chatId: String, onState: (ChatState) -> Unit, onFailure: (String) -> Unit) {
    var delayMs = 1000L
    while (true) {
        try {
            onState(session.api.chat(chatId))
            var opened = false
            session.api.chatEvents(chatId) { next ->
                onState(next)
                delayMs = 1000L
                // The stream reads the chat's notifications before its first event.
                if (!opened) {
                    opened = true
                    session.launch { session.loadInbox() }
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            onFailure(error.message ?: "Golem is not reachable")
        }
        delay(delayMs)
        delayMs = minOf(delayMs * 2, 16_000L)
    }
}

/**
 * An action the agent waits for the person to allow: once, for the rest of the turn on that machine when it allows
 * that, or not; `gold` at its side. A long text, such as the body of an email, scrolls.
 */
@Composable
private fun ApprovalCard(approval: Approval, chatId: String, modifier: Modifier = Modifier) {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    fun answer(allow: Boolean, scope_: String = "once") {
        busy = true
        scope.launch {
            session.run { session.api.answerApproval(chatId, approval.id, allow, scope_) }
            busy = false
        }
    }
    val shape = RoundedCornerShape(Tokens.Radius.xl)
    Row(modifier.fillMaxWidth().raisedCard(Tokens.Radius.xl, ring = Golem.colors.ringControl).clip(shape)) {
        Box(Modifier.width(3.dp).fillMaxHeight().heightIn(min = 80.dp).background(Golem.colors.gold))
        Column(Modifier.padding(Tokens.Space.lg), verticalArrangement = Arrangement.spacedBy(Tokens.Space.md)) {
            Text(
                approval.text, style = golemText(Tokens.FontSize.md).copy(fontFamily = FontFamily.Monospace),
                color = Golem.colors.textSecondary,
                modifier = Modifier.fillMaxWidth().heightIn(max = 240.dp).verticalScroll(rememberScrollState()),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm)) {
                GolemButton("Allow", { answer(true) }, variant = ButtonVariant.Primary, size = ButtonSize.Small, enabled = !busy)
                if (approval.allowsTurn) {
                    GolemButton("Allow for this turn", { answer(true, "turn") }, size = ButtonSize.Small, enabled = !busy)
                }
                GolemButton("Deny", { answer(false) }, variant = ButtonVariant.Danger, size = ButtonSize.Small, enabled = !busy)
            }
        }
    }
}

