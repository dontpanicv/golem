package dev.golem.views

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.CircleButton
import dev.golem.design.FileChips
import dev.golem.design.Golem
import dev.golem.design.GolemMenu
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.Tokens
import dev.golem.design.golemShadow
import dev.golem.design.golemText
import dev.golem.design.ticking
import dev.golem.voice.Dictation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * The bottom of a screen with a composer: the composer 20 dp from the screen edges, 8 dp over the tab bar, or over the
 * keyboard while it shows.
 */
@Composable
fun ComposerRow(content: @Composable () -> Unit) {
    Box(
        Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
            .padding(horizontal = Tokens.Space.lg).padding(bottom = Tokens.Space.md),
    ) { content() }
}

/**
 * A message box with the files picked to send with it, and dictation into it, as T3's: a rounded field with the add
 * button at the start, then the mic and the round send button. `owner` keys the dictation: the chat, or the topic
 * of a new chat. While `sending`, the send button spins. With `stop`, while the agent works, an empty composer
 * shows Stop in the send button's place, and the send button steers.
 */
@Composable
fun Composer(
    owner: String,
    placeholder: String,
    draft: String,
    onDraft: (String) -> Unit,
    files: List<File>,
    onFiles: (List<File>) -> Unit,
    sending: Boolean,
    send: () -> Unit,
    autofocus: Boolean = false,
    stop: (() -> Unit)? = null,
) {
    val session = LocalSession.current
    val dictation = session.dictation
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    val view = LocalView.current
    val listening = dictation.owner == owner && dictation.state == Dictation.State.Listening
    val canSend = draft.isNotBlank() || files.isNotEmpty() || listening
    val shape = RectangleShape
    val context = LocalContext.current
    val microphone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) dictation.start(owner, draft.trim()) else session.show("Golem needs the microphone to dictate.")
    }

    LaunchedEffect(autofocus) { if (autofocus) focus.requestFocus() }
    LaunchedEffect(dictation.state) {
        if (dictation.state == Dictation.State.Failed && dictation.owner == null) dictation.error?.let { session.show(it) }
    }
    // The screen stays on while dictating; leaving the screen stops the dictation.
    DisposableEffect(listening) {
        view.keepScreenOn = listening
        onDispose { view.keepScreenOn = false }
    }
    DisposableEffect(owner) { onDispose { if (dictation.owner == owner) dictation.cancel() } }

    fun startListening() {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            dictation.start(owner, draft.trim())
        } else {
            microphone.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    /** Stops listening and keeps the words in the field, to edit. */
    fun keep() {
        scope.launch {
            val kept = dictation.stop()
            if (kept.isNotEmpty()) onDraft(kept)
            focus.requestFocus()
        }
    }

    fun submit() {
        if (!listening) return send()
        scope.launch {
            onDraft(dictation.stop())
            send()
        }
    }

    Column(
        Modifier.fillMaxWidth()
            .golemShadow(Tokens.Shadows.composer, shape)
            .border(1.dp, Golem.colors.textTertiary, shape)
            .clip(shape)
            .background(Golem.colors.surfaceComposer),
    ) {
        if (files.isNotEmpty()) {
            FileChips(files.map { it.name }, remove = { index -> onFiles(files.filterIndexed { i, _ -> i != index }) },
                modifier = Modifier.padding(horizontal = Tokens.Space.lg).padding(top = Tokens.Space.sm))
        }
        Row(Modifier.fillMaxWidth().heightIn(min = Tokens.Mobile.Size.voice), verticalAlignment = Alignment.Bottom) {
            if (listening) {
                RecordingBar(dictation, cancel = dictation::cancel, keep = ::keep, modifier = Modifier.weight(1f))
            } else {
                AttachMenu { onFiles(files + it) }
                BasicTextField(
                    draft, onDraft, maxLines = 4,
                    textStyle = golemText(Tokens.Mobile.FontSize.body).copy(color = Golem.mobile.text),
                    cursorBrush = SolidColor(Golem.colors.accent),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.weight(1f).padding(vertical = 14.dp).focusRequester(focus)
                        .semantics { contentDescription = placeholder },
                    decorationBox = { field ->
                        Box {
                            if (draft.isEmpty()) {
                                Text(placeholder, style = golemText(Tokens.Mobile.FontSize.body), color = Golem.mobile.placeholder)
                            }
                            field()
                        }
                    },
                )
            }
            if (!listening && dictation.available) {
                IconButton(::startListening) { Icon(Pixel.Mic.vector, "Dictate", tint = Golem.mobile.title) }
            }
            if (stop != null && !canSend) {
                CircleButton(Pixel.Stop.vector, "Stop", stop, tint = Golem.mobile.danger)
            } else {
                CircleButton(
                    if (stop == null) Pixel.Send.vector else Pixel.Redo.vector,
                    if (sending) "Sending" else if (stop == null) "Send" else "Steer",
                    ::submit, enabled = canSend, busy = sending,
                )
            }
        }
    }
}

/** While dictating: a cancel button, the words as they are heard, which a tap keeps to edit, and the time. */
@Composable
private fun RecordingBar(dictation: Dictation, cancel: () -> Unit, keep: () -> Unit, modifier: Modifier) {
    val now = ticking(true)
    val level by animateFloatAsState(dictation.level, label = "level")
    val words = listOf(dictation.prefix, dictation.text).filter { it.isNotBlank() }.joinToString(" ")
    Row(modifier.heightIn(min = Tokens.Mobile.Size.voice), verticalAlignment = Alignment.CenterVertically) {
        IconButton(cancel) { Icon(Pixel.Close.vector, "Cancel dictation", tint = Golem.mobile.textSecondary) }
        Box(Modifier.size(8.dp + 8.dp * level).clip(RectangleShape).background(Golem.mobile.danger))
        Text(
            words.ifEmpty { "Listening…" }, style = golemText(Tokens.Mobile.FontSize.body),
            color = if (words.isEmpty()) Golem.mobile.placeholder else Golem.mobile.text,
            modifier = Modifier.weight(1f).clickable(onClick = keep).padding(horizontal = Tokens.Space.md, vertical = 14.dp),
        )
        val seconds = ((now - dictation.startedAt) / 1000).coerceAtLeast(0)
        Text("%d:%02d".format(seconds / 60, seconds % 60), style = golemText(Tokens.Mobile.FontSize.small),
            color = Golem.mobile.textTertiary)
        Box(Modifier.width(Tokens.Space.md))
    }
}

/** The add button's menu: pictures from the photo picker, a photo from the camera, or files from the Files app. */
@Composable
fun AttachMenu(add: (List<File>) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var expanded by remember { mutableStateOf(false) }
    var photo by remember { mutableStateOf<File?>(null) }
    fun copy(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch { add(uris.mapNotNull { pickedCopy(context, it) }) }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(), ::copy)
    val documents = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), ::copy)
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        photo?.takeIf { taken && it.length() > 0 }?.let { add(listOf(it)) }
    }
    Box {
        IconButton({ expanded = true }, Modifier.size(Tokens.Mobile.Size.voice)) {
            Icon(Pixel.Plus.vector, "Attach file", tint = Golem.mobile.title)
        }
        GolemMenu(expanded, { expanded = false }, listOf(
            MenuAction("Photos", Pixel.Photo.vector) {
                photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
            },
            MenuAction("Camera", Pixel.Camera.vector) {
                val file = File(File(context.cacheDir, UUID.randomUUID().toString()).apply { mkdirs() }, "Photo.jpg")
                photo = file
                camera.launch(FileProvider.getUriForFile(context, "${context.packageName}.files", file))
            },
            MenuAction("Files", Pixel.Folder.vector) { documents.launch(arrayOf("*/*")) },
        ))
    }
}

/** A copy of a picked file in the cache, under its own name: the picked address is readable only for a while. */
suspend fun pickedCopy(context: Context, uri: Uri): File? = withContext(Dispatchers.IO) {
    runCatching {
        val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: uri.lastPathSegment ?: "File"
        val copy = File(File(context.cacheDir, UUID.randomUUID().toString()).apply { mkdirs() }, name.replace('/', '_'))
        context.contentResolver.openInputStream(uri)!!.use { input -> copy.outputStream().use { input.copyTo(it) } }
        copy
    }.getOrNull()
}
