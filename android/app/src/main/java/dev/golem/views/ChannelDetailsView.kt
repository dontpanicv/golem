package dev.golem.views

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.foundation.text.KeyboardOptions
import dev.golem.api.Brief
import dev.golem.api.Destination
import dev.golem.api.FileRef
import dev.golem.api.Routine
import dev.golem.api.RoutineRun
import dev.golem.api.Toast
import dev.golem.api.deleteRoutine
import dev.golem.api.routines
import dev.golem.api.runRoutine
import dev.golem.api.setRoutine
import dev.golem.design.Badge
import dev.golem.design.DetailTitle
import dev.golem.design.Golem
import dev.golem.design.GolemSwitch
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.SettingsRow
import dev.golem.design.Tokens
import dev.golem.design.Tone
import dev.golem.design.golemText
import kotlinx.coroutines.CancellationException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * A channel's name, its summary and brief, its routines, and their newest runs. People create routines by asking an
 * agent; the model writes the summary and the brief from the channel's threads.
 */
@Composable
fun ChannelDetailsView(id: String) {
    val session = LocalSession.current
    val open = LocalOpen.current
    val opener = rememberFileOpener()
    val channel = session.channels.firstOrNull { it.id == id }
    val workspaceId = session.workspace?.id ?: return
    var routines by remember { mutableStateOf<List<Routine>>(emptyList()) }
    var runs by remember { mutableStateOf<List<RoutineRun>>(emptyList()) }
    var brief by remember { mutableStateOf<Brief?>(null) }
    var name by remember(channel?.name) { mutableStateOf(channel?.name ?: "") }
    val renamed = name.isNotBlank() && name.trim() != channel?.name

    suspend fun load() {
        session.reloadWorkspace()
        val found = session.api.routines(workspaceId, id)
        routines = found.routines
        runs = found.runs
        brief = session.api.brief(workspaceId, id)
    }

    LaunchedEffect(id) { session.run { load() } }

    fun rename() {
        if (!renamed) return
        val newName = name.trim()
        session.launch {
            session.renameChannel(id, newName)
            session.show("Saved", Toast.Tone.Success)
        }
    }

    fun setEnabled(routine: Routine, enabled: Boolean) {
        routines = routines.map { if (it.id == routine.id) it.copy(enabled = enabled) else it }
        session.launch {
            try {
                val saved = session.api.setRoutine(routine.id, enabled)
                routines = routines.map { if (it.id == saved.id) saved else it }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                routines = routines.map { if (it.id == routine.id) it.copy(enabled = !enabled) else it }
                throw error
            }
        }
    }

    // The brief's links open here instead of leaving the app, as a thread's do.
    val system = LocalUriHandler.current
    val links = remember(system) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val target = uri.substringAfter(':')
                when (uri.substringBefore(':')) {
                    "thread" -> open(Destination.Thread(target))
                    "file" -> opener(FileRef(target, ""))
                    "artifact" -> open(Destination.Artifact(id, target))
                    else -> runCatching { system.openUri(uri) }
                }
            }
        }
    }

    SettingsScreen("# ${channel?.name ?: ""}") {
        DetailTitle("# ${channel?.name ?: ""}", caption = "Channel details",
            modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md))
        SettingsGroup("Channel") {
            FieldWithButton(name, { name = it }, "Name", "Save", enabled = renamed, ::rename,
                KeyboardOptions(capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Done))
        }
        channel?.summary?.let { summary ->
            SettingsGroup("Summary") {
                Text(summary, style = golemText(Tokens.Mobile.FontSize.row), color = Golem.mobile.text,
                    modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.sm))
            }
        }
        brief?.let { current ->
            SettingsGroup("Brief") {
                CompositionLocalProvider(LocalUriHandler provides links) {
                    Copyable(current.text) {
                        MarkdownText(current.text, size = Tokens.Mobile.FontSize.row, working = session.working,
                            modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.sm))
                    }
                }
            }
        }
        SettingsGroup("Routines") {
            if (routines.isEmpty()) SettingsEmptyRow("No routines yet")
            routines.forEach { routine ->
                SettingsRow(
                    routine.name,
                    description = routine.nextRunAt?.let { "Next ${time(it)}" }
                        ?: (if (routine.enabled) routine.place?.summary else null) ?: "Paused",
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        GolemSwitch(routine.enabled, { setEnabled(routine, it) }, label = "Run ${routine.name}")
                        SettingsRowMenu("${routine.name} actions", buildList {
                            routine.threadId?.let { thread ->
                                add(MenuAction("Open thread", Icons.Outlined.Edit) { open(Destination.Thread(thread)) })
                            }
                            add(MenuAction("Run now", Icons.Outlined.PlayArrow) {
                                session.launch {
                                    session.api.runRoutine(routine.id)
                                    session.show("${routine.name} runs now", Toast.Tone.Success)
                                    load()
                                }
                            })
                            add(MenuAction("Delete", Icons.Outlined.Delete, danger = true) {
                                session.launch {
                                    session.api.deleteRoutine(routine.id)
                                    routines = routines.filter { it.id != routine.id }
                                    session.show("${routine.name} deleted", Toast.Tone.Success)
                                }
                            })
                        })
                    }
                }
            }
        }
        SettingsGroup("Runs") {
            if (runs.isEmpty()) SettingsEmptyRow("No runs yet")
            runs.forEach { run ->
                SettingsRow(run.routineName, description = listOfNotNull(time(run.startedAt), run.error).joinToString(" · ")) {
                    when (run.outcome) {
                        "running" -> Badge("Running", Tone.Accent)
                        "posted" -> Badge("Posted", Tone.Success)
                        "failed" -> Badge("Failed", Tone.Danger)
                        else -> Badge("Quiet")
                    }
                }
            }
        }
    }
}

/** A time as "Mon 3 Nov 14:05", in the phone's language. */
private fun time(milliseconds: Double): String {
    val pattern = android.text.format.DateFormat.getBestDateTimePattern(Locale.getDefault(), "EEEdMMMjmm")
    return SimpleDateFormat(pattern, Locale.getDefault()).format(Date(milliseconds.toLong()))
}
