package dev.golem.views

import android.content.ActivityNotFoundException
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import dev.golem.api.Artifact
import dev.golem.api.FileRef
import dev.golem.api.SavedFile
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.EmptyState
import dev.golem.design.Golem
import dev.golem.design.GolemMenu
import dev.golem.design.ListRow
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.PillBar
import dev.golem.design.Tokens
import dev.golem.design.golemText
import kotlinx.coroutines.launch
import java.io.File

/**
 * Files, artifacts, and the open artifact of a topic beside the topic or one of its chats, or of the workspace
 * beside the orchestrator (a null `topicId`), in a sheet as Material has it on a phone. `changes` changes when the
 * chat does, so the lists load again; `artifactId` opens one at once, as a link or a search result does.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArtifactsPanel(topicId: String?, changes: Int, artifactId: String?, onDismiss: () -> Unit) {
    val session = LocalSession.current
    val workspaceId = session.workspace?.id ?: return
    var tab by remember { mutableStateOf("Files") }
    var files by remember { mutableStateOf<List<SavedFile>>(emptyList()) }
    var artifacts by remember { mutableStateOf<List<Artifact>>(emptyList()) }
    var openArtifact by remember { mutableStateOf(artifactId) }
    var artifactChanges by remember { mutableIntStateOf(0) }
    var uploading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val opener = rememberFileOpener()
    LaunchedEffect(changes) { session.run { files = session.api.files(workspaceId, topicId) } }
    LaunchedEffect(changes, artifactChanges) {
        session.run {
            artifacts = session.api.artifacts(workspaceId, topicId)
            if (openArtifact != null && artifacts.none { it.id == openArtifact }) openArtifact = null
        }
    }
    // An open artifact takes the drags itself; its sheet closes with the close button or Back.
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss, sheetState = sheet, containerColor = Golem.mobile.background,
        sheetGesturesEnabled = openArtifact == null,
    ) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
            Row(Modifier.fillMaxWidth().padding(vertical = Tokens.Space.xs), verticalAlignment = Alignment.CenterVertically) {
                if (openArtifact != null) {
                    IconButton({ openArtifact = null; tab = "Artifacts" }, Modifier.padding(start = Tokens.Space.sm)) {
                        Icon(Pixel.Back.vector, "Back to artifacts", tint = Golem.mobile.title)
                    }
                    Box(Modifier.weight(1f))
                } else {
                    Box(Modifier.weight(1f)) { PillBar(tab, listOf("Files", "Artifacts"), { it }, { tab = it }) }
                }
                IconButton(onDismiss, Modifier.padding(end = Tokens.Space.sm)) {
                    Icon(Pixel.Close.vector, "Close", tint = Golem.mobile.title)
                }
            }
            val shown = openArtifact
            when {
                shown != null -> ArtifactView(shown, changes) { artifactChanges++ }
                tab == "Artifacts" -> if (artifacts.isEmpty()) {
                    EmptyState("No artifacts yet")
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(artifacts, key = { it.id }) { artifact ->
                            ListRow(artifact.title, icon = Pixel.Artifact.vector, onClick = { openArtifact = artifact.id }) {
                                Text("${artifact.visitors}", style = golemText(Tokens.Mobile.FontSize.small), color = Golem.mobile.textQuaternary)
                            }
                        }
                    }
                }
                else -> Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
                    UploadButton(uploading) { picked ->
                        uploading = true
                        scope.launch {
                            session.run { files = session.api.uploadFiles(workspaceId, topicId, picked) }
                            uploading = false
                        }
                    }
                    if (files.isEmpty()) {
                        EmptyState("No files yet")
                    } else {
                        LazyColumn(Modifier.fillMaxSize()) {
                            items(files.reversed(), key = { it.id }) { file -> FileRow(file, { opener(file.ref) }) {
                                session.launch { files = session.api.deleteFile(workspaceId, file.id) }
                            } }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FileRow(file: SavedFile, open: () -> Unit, delete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Box {
        ListRow(file.name, icon = Pixel.File.vector, onClick = open, onLongClick = { menu = true })
        GolemMenu(menu, { menu = false }, listOf(MenuAction("Delete file", Pixel.Trash.vector, danger = true, action = delete)))
    }
}

/** Upload files: the attach menu's choices, with a spinner while files upload. */
@Composable
private fun UploadButton(uploading: Boolean, upload: (List<File>) -> Unit) {
    Row(Modifier.padding(horizontal = Tokens.Space.sm), verticalAlignment = Alignment.CenterVertically) {
        AttachMenu(upload)
        Text(if (uploading) "Uploading…" else "Upload files", style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book),
            color = Golem.mobile.text)
    }
}

/**
 * Opens a file of the workspace in the app that shows its kind, as Quick Look does on the iPhone: it downloads to the
 * cache, then the system offers the viewer.
 */
@Composable
fun rememberFileOpener(): (FileRef) -> Unit {
    val session = LocalSession.current
    val context = LocalContext.current
    return remember(session, context) {
        { file ->
            val workspace = session.workspace
            if (workspace != null) session.launch {
                val folder = File(context.cacheDir, "files/${file.id}")
                val local = session.api.download(workspace.id, file, folder)
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", local)
                val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(local.extension.lowercase()) ?: "application/octet-stream"
                val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                try {
                    context.startActivity(Intent.createChooser(view, local.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (_: ActivityNotFoundException) {
                    session.show("No app opens ${local.name}.")
                }
            }
        }
    }
}

