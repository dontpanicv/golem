package dev.golem.views

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import dev.golem.design.ButtonVariant
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemDialog
import dev.golem.design.GolemSwitch
import dev.golem.design.GolemTextField
import dev.golem.design.LocalSession
import dev.golem.design.Tokens
import dev.golem.design.golemText
import kotlinx.coroutines.launch

/** Asks for a new topic's name, and whether only the person sees it. It stays open when creating fails. */
@Composable
fun NewTopicDialog(onDismiss: () -> Unit, create: suspend (String, Boolean) -> Unit) {
    var name by remember { mutableStateOf("") }
    var private by remember { mutableStateOf(false) }
    BusyDialog("New topic", "Create", onDismiss, enabled = name.isNotBlank(), act = { create(name.trim(), private) }) { submit ->
        GolemTextField(
            name, { name = it }, placeholder = "Name", autofocus = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Private", style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book), color = Golem.mobile.text,
                modifier = Modifier.weight(1f))
            GolemSwitch(private, { private = it }, label = "Private")
        }
    }
}

/** Asks before something that cannot go back, such as a merge or a delete. It stays open when the action fails. */
@Composable
fun ConfirmDialog(title: String, message: String, action: String, onDismiss: () -> Unit, danger: Boolean = false, act: suspend () -> Unit) {
    BusyDialog(title, action, onDismiss, danger = danger, act = act) {
        Text(message, style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book), color = Golem.mobile.textSecondary)
    }
}

/**
 * A dialog with Cancel and one action, which runs in the session's scope: the dialog closes when it succeeds and stays
 * open with a toast when it fails; with `dismissOnSuccess` false it stays open for a next step. `content` gets the
 * action, for the keyboard's Done.
 */
@Composable
fun BusyDialog(
    title: String,
    action: String,
    onDismiss: () -> Unit,
    enabled: Boolean = true,
    danger: Boolean = false,
    dismissOnSuccess: Boolean = true,
    act: suspend () -> Unit,
    content: @Composable (submit: () -> Unit) -> Unit,
) {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    fun submit() {
        if (busy || !enabled) return
        busy = true
        scope.launch {
            var done = false
            session.run {
                act()
                done = true
            }
            busy = false
            if (done && dismissOnSuccess) onDismiss()
        }
    }
    GolemDialog(title, onDismiss, actions = {
        GolemButton("Cancel", onDismiss)
        GolemButton(action, ::submit, variant = if (danger) ButtonVariant.Danger else ButtonVariant.Primary,
            enabled = enabled, busy = busy)
    }) { content(::submit) }
}
