package dev.golem.views

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.golem.api.Learned
import dev.golem.api.deleteLearned
import dev.golem.api.learned
import dev.golem.api.setLearned
import dev.golem.design.Golem
import dev.golem.design.GolemTextField
import dev.golem.design.ListSubheading
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.Tokens
import dev.golem.design.golemText
import kotlinx.coroutines.CancellationException

/**
 * What Golem learned from quiet threads that the person sees: facts about each member, then the how-tos of each
 * channel and of the person's own Golem. A lock marks an entry only the person sees. A change shows at once and goes
 * back when the server refuses it.
 */
@Composable
fun LearnedSection(workspaceId: String) {
    val session = LocalSession.current
    var learned by remember { mutableStateOf<List<Learned>>(emptyList()) }
    var editing by remember { mutableStateOf<Learned?>(null) }

    LaunchedEffect(workspaceId) { session.run { learned = session.api.learned(workspaceId) } }

    /** Shows `change` at once, and the entries before it again when the server refuses it. */
    fun optimistic(change: List<Learned>, request: suspend () -> Unit) {
        val before = learned
        learned = change
        session.launch {
            try {
                request()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                learned = before
                throw error
            }
        }
    }

    fun title(entry: Learned): String = when (entry.kind) {
        "about" -> "About ${session.members.firstOrNull { it.userId == entry.personId }?.name ?: "a former member"}"
        else -> entry.channelId?.let { id -> "#${session.channels.firstOrNull { it.id == id }?.name ?: "deleted channel"}" } ?: "Your Golem"
    }

    SettingsGroup("What Golem learned") {
        if (learned.isEmpty()) SettingsEmptyRow("Nothing yet")
        // In the server's order, facts first; each group where its first entry is.
        learned.groupBy(::title).forEach { (title, entries) ->
            ListSubheading(title)
            entries.forEach { entry ->
                Row(
                    Modifier.fillMaxWidth().padding(start = Tokens.Mobile.Size.margin, end = Tokens.Space.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md),
                ) {
                    Text(entry.text, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book), color = Golem.mobile.text,
                        modifier = Modifier.weight(1f).padding(vertical = Tokens.Space.md))
                    if (entry.realm != null) {
                        Icon(Icons.Outlined.Lock, "Only you see this", Modifier.size(14.dp), tint = Golem.mobile.textQuaternary)
                    }
                    SettingsRowMenu("Entry actions", listOf(
                        MenuAction("Edit", Icons.Outlined.Edit) { editing = entry },
                        MenuAction("Delete", Icons.Outlined.Delete, danger = true) {
                            optimistic(learned.filter { it.id != entry.id }) { session.api.deleteLearned(workspaceId, entry.id) }
                        },
                    ))
                }
            }
        }
    }

    editing?.let { entry ->
        var text by remember(entry.id) { mutableStateOf(entry.text) }
        val trimmed = text.trim()
        BusyDialog("Edit", "Save", { editing = null }, enabled = trimmed.isNotEmpty() && trimmed != entry.text, act = {
            optimistic(learned.map { if (it.id == entry.id) it.copy(text = trimmed) else it }) {
                val saved = session.api.setLearned(workspaceId, entry.id, trimmed)
                learned = learned.map { if (it.id == saved.id) saved else it }
            }
        }) {
            GolemTextField(text, { text = it }, placeholder = "Text", singleLine = false, minLines = 3, autofocus = true,
                modifier = Modifier.heightIn(max = 320.dp))
        }
    }
}
