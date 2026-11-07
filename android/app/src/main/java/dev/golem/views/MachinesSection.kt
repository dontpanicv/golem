package dev.golem.views

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import dev.golem.api.Machine
import dev.golem.api.Pairing
import dev.golem.api.Toast
import dev.golem.api.machines
import dev.golem.api.removeMachine
import dev.golem.api.setMachineShared
import dev.golem.api.startPairing
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemSwitch
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.SettingsRow
import dev.golem.design.Tokens
import dev.golem.design.golemText
import kotlinx.coroutines.delay

/** The person's own machines, which they share with every member's turns or keep private, and the ones other members shared. */
@Composable
fun MachinesSection(workspaceId: String) {
    val session = LocalSession.current
    var machines by remember { mutableStateOf<List<Machine>>(emptyList()) }
    var pairing by remember { mutableStateOf<Pairing?>(null) }
    suspend fun load() {
        val found = session.api.machines(workspaceId)
        machines = found.machines
        pairing = found.pairing
    }

    LaunchedEffect(workspaceId) { session.run { load() } }
    // While a pairing waits, look for the machine every 2 seconds.
    LaunchedEffect(pairing) {
        while (pairing != null) {
            delay(2_000)
            runCatching { load() }
        }
    }

    SettingsGroup("Machines") {
        machines.forEach { machine ->
            if (machine.pairedBy == session.user?.id) {
                SettingsRow(machine.name, description = "${machine.summary} · ${if (machine.shared) "Shared" else "Private"}") {
                    GolemSwitch(!machine.shared, { private ->
                        session.launch {
                            val saved = session.api.setMachineShared(workspaceId, machine.id, !private)
                            machines = machines.map { if (it.id == saved.id) saved else it }
                        }
                    }, label = "Private")
                    SettingsRowMenu("Machine actions", listOf(
                        MenuAction("Remove machine", Icons.Outlined.Delete, danger = true) {
                            session.launch {
                                session.api.removeMachine(workspaceId, machine.id)
                                machines = machines.filter { it.id != machine.id }
                            }
                        },
                    ))
                }
            } else {
                SettingsRow(machine.name, description = "${machine.summary} · Shared by ${machine.pairedByName}")
            }
        }
        val current = pairing
        if (current != null) {
            PairingCommand(current)
        } else {
            SettingsAddButton("Add machine") { session.launch { pairing = session.api.startPairing(workspaceId) } }
        }
    }
}

/** The command that installs hands on a machine and pairs it with the person. */
@Composable
private fun PairingCommand(pairing: Pairing) {
    val session = LocalSession.current
    val clipboard = LocalClipboardManager.current
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.lg),
        verticalArrangement = Arrangement.spacedBy(Tokens.Space.lg),
    ) {
        Text("Run this on the Mac or Linux computer within 10 minutes", style = golemText(Tokens.FontSize.sm, Tokens.FontWeight.book),
            color = Golem.mobile.textTertiary)
        SelectionContainer {
            Text(pairing.command, style = golemText(Tokens.FontSize.sm).copy(fontFamily = FontFamily.Monospace), color = Golem.mobile.text)
        }
        GolemButton("Copy command", {
            clipboard.setText(AnnotatedString(pairing.command))
            session.show("Copied", Toast.Tone.Success)
        })
    }
}
