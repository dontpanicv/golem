package dev.golem.views

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.golem.api.Member
import dev.golem.api.Toast
import dev.golem.design.Badge
import dev.golem.design.GolemButton
import dev.golem.design.GolemTextField
import dev.golem.design.LocalSession
import dev.golem.design.PersonAvatar
import dev.golem.design.SettingsRow
import dev.golem.design.Tokens

/** The facts, members, and name of the workspace; only an owner adds members and renames it. It opens over the tabs. */
@Composable
fun WorkspaceSettingsView() {
    val session = LocalSession.current
    val workspace = session.workspace ?: return
    val ownerOfWorkspace = workspace.role == "owner"
    var members by remember { mutableStateOf<List<Member>>(emptyList()) }
    var facts by remember { mutableStateOf("") }
    var savedFacts by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var name by remember(workspace.name) { mutableStateOf(workspace.name) }
    val renamed = name.isNotBlank() && name.trim() != workspace.name

    LaunchedEffect(workspace.id) {
        session.run {
            members = session.api.members(workspace.id)
            savedFacts = session.api.facts(workspace.id).text
            facts = savedFacts
        }
    }

    fun saveFacts() {
        val text = facts
        session.launch {
            savedFacts = session.api.setFacts(workspace.id, text).text
            facts = savedFacts
            session.show("Saved", Toast.Tone.Success)
        }
    }

    fun addMember() {
        val address = email.trim()
        if (address.isEmpty()) return
        session.launch {
            val member = session.api.addMember(workspace.id, address)
            members = members + member
            email = ""
            session.show("Added ${member.name}", Toast.Tone.Success)
        }
    }

    fun rename() {
        if (!renamed) return
        val newName = name.trim()
        session.launch {
            session.renameWorkspace(newName)
            session.show("Saved", Toast.Tone.Success)
        }
    }

    SettingsScreen(workspace.name) {
        SettingsGroup("Facts") {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = Tokens.Mobile.Size.margin).padding(bottom = Tokens.Space.lg),
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(Tokens.Space.md),
            ) {
                GolemTextField(facts, { facts = it }, placeholder = "Names, birthdays, addresses, work", singleLine = false,
                    minLines = 6, large = true)
                GolemButton("Save", ::saveFacts, enabled = facts != savedFacts)
            }
        }
        SettingsGroup("Members") {
            members.forEach { member ->
                SettingsRow(member.name, description = member.email, leading = { PersonAvatar(member.name, member.picture, 32.dp) }) {
                    Badge(member.role.replaceFirstChar { it.uppercase() })
                }
            }
            if (ownerOfWorkspace) {
                FieldWithButton(email, { email = it }, "Email address", "Add", enabled = email.isNotBlank(), ::addMember,
                    KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Email, imeAction = ImeAction.Done))
            }
        }
        if (ownerOfWorkspace) {
            SettingsGroup("Workspace") {
                FieldWithButton(name, { name = it }, "Name", "Save", enabled = renamed, ::rename,
                    KeyboardOptions(imeAction = ImeAction.Done))
            }
        }
    }
}

/** A one-line field and its button in a row, as a group's own form; the keyboard's Done presses the button. */
@Composable
fun FieldWithButton(
    value: String, onValueChange: (String) -> Unit, placeholder: String, action: String, enabled: Boolean, act: () -> Unit,
    keyboardOptions: KeyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md),
    ) {
        GolemTextField(value, onValueChange, Modifier.weight(1f), placeholder = placeholder, keyboardOptions = keyboardOptions,
            keyboardActions = KeyboardActions(onDone = { if (enabled) act() }))
        GolemButton(action, act, enabled = enabled)
    }
}
