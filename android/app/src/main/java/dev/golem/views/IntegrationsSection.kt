package dev.golem.views

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.golem.api.Credential
import dev.golem.api.Integration
import dev.golem.api.Toast
import dev.golem.api.addCredential
import dev.golem.api.connectIntegration
import dev.golem.api.deleteCredential
import dev.golem.api.finishLink
import dev.golem.api.finishSignIn
import dev.golem.api.integrations
import dev.golem.api.linkIntegration
import dev.golem.api.setCredential
import dev.golem.api.setIntegrationClient
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.ButtonSize
import dev.golem.design.ButtonVariant
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemDialog
import dev.golem.design.GolemSwitch
import dev.golem.design.GolemTextField
import dev.golem.design.ListSeparator
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.SettingsRow
import dev.golem.design.Tokens
import dev.golem.design.golemText

/**
 * The integrations, with the person's own credentials, which they share with every member's turns or keep private, and
 * the ones other members shared. Secrets go to the server and never come back.
 */
@Composable
fun IntegrationsSection(workspaceId: String) {
    val session = LocalSession.current
    var integrations by remember { mutableStateOf<List<Integration>>(emptyList()) }
    var dialog by remember { mutableStateOf<IntegrationDialog?>(null) }
    suspend fun load() {
        integrations = session.api.integrations(workspaceId)
    }
    fun added(integration: Integration, credential: Credential) {
        integrations = integrations.map { if (it.id == integration.id) it.copy(credentials = it.credentials + credential) else it }
    }
    fun replace(credential: Credential) {
        integrations = integrations.map { integration ->
            integration.copy(credentials = integration.credentials.map { if (it.id == credential.id) credential else it })
        }
    }

    LaunchedEffect(workspaceId) { session.run { load() } }

    SettingsGroup("Integrations") {
        integrations.forEachIndexed { index, integration ->
            if (index > 0) ListSeparator()
            // The integration's actions sit in its row, as on the web: Client, then the way to connect, then help.
            SettingsRow(integration.name, description = summary(integration)) {
                if (integration.client?.changeable == true) {
                    GolemButton("Client", { dialog = IntegrationDialog.Client(integration) }, size = ButtonSize.Small)
                }
                when (integration.connect) {
                    "sign-in" -> GolemButton(
                        "Connect", {
                            if (integration.address) {
                                dialog = IntegrationDialog.SignIn(integration, null)
                            } else {
                                session.launch {
                                    dialog = IntegrationDialog.SignIn(integration, session.api.connectIntegration(workspaceId, integration.id).url)
                                }
                            }
                        },
                        size = ButtonSize.Small, enabled = integration.client?.let { it.clientId != null } ?: true,
                    )
                    "phone" -> GolemButton("Link number", { dialog = IntegrationDialog.Link(integration) }, size = ButtonSize.Small)
                    else -> GolemButton("Add credential", { dialog = IntegrationDialog.Secret(integration) }, size = ButtonSize.Small)
                }
                if (integration.guide.isNotEmpty()) {
                    IconButton({ dialog = IntegrationDialog.Guide(integration) }) {
                        Icon(Pixel.Info.vector, "Set up ${integration.name}", tint = Golem.mobile.textSecondary)
                    }
                }
            }
            integration.credentials.forEach { credential ->
                if (credential.ownerId == session.user?.id) {
                    SettingsRow(credential.label, description = if (credential.shared) "Shared" else "Private") {
                        GolemSwitch(!credential.shared, { private ->
                            session.launch { replace(session.api.setCredential(workspaceId, credential.id, "shared" to !private)) }
                        }, label = "Private")
                        SettingsRowMenu("Credential actions", listOf(
                            MenuAction("Delete credential", Pixel.Trash.vector, danger = true) {
                                session.launch {
                                    session.api.deleteCredential(workspaceId, credential.id)
                                    integrations = integrations.map { it.copy(credentials = it.credentials.filter { c -> c.id != credential.id }) }
                                }
                            },
                        ))
                    }
                    if (integration.watchable) {
                        SettingsRow("Read for me") {
                            GolemSwitch(credential.watched, { watched ->
                                session.launch { replace(session.api.setCredential(workspaceId, credential.id, "watched" to watched)) }
                            }, label = "Read ${credential.label} for me")
                        }
                    }
                } else {
                    SettingsRow(credential.label, description = "Shared by ${credential.ownerName}")
                }
            }
        }
    }

    when (val shown = dialog) {
        null -> Unit
        is IntegrationDialog.SignIn -> SignInForm(workspaceId, shown.integration, shown.page, { dialog = null }) { added(shown.integration, it) }
        is IntegrationDialog.Link -> LinkForm(workspaceId, shown.integration, { dialog = null }) { added(shown.integration, it) }
        is IntegrationDialog.Secret -> CredentialForm(workspaceId, shown.integration, { dialog = null }) { added(shown.integration, it) }
        is IntegrationDialog.Client -> ClientForm(shown.integration, { dialog = null }) { session.run { load() } }
        is IntegrationDialog.Guide -> Guide(shown.integration) { dialog = null }
    }
}

/** The dialog of an integration that is open. */
private sealed interface IntegrationDialog {
    data class SignIn(val integration: Integration, val page: String?) : IntegrationDialog
    data class Link(val integration: Integration) : IntegrationDialog
    data class Secret(val integration: Integration) : IntegrationDialog
    data class Client(val integration: Integration) : IntegrationDialog
    data class Guide(val integration: Integration) : IntegrationDialog
}

/** The count of accounts, and what the secret is, as on the web. */
private fun summary(integration: Integration): String {
    val count = integration.credentials.size
    val accounts = when (count) {
        0 -> "Not connected"
        1 -> "1 account"
        else -> "$count accounts"
    }
    return integration.secretLabel?.let { "$accounts · $it" } ?: accounts
}

private val plain = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)
private val webAddress = plain.copy(keyboardType = KeyboardType.Uri)
private val secret = plain.copy(keyboardType = KeyboardType.Password)

/**
 * Signs in to an integration on its own page in a Custom Tab, which ends at a localhost address that the person pastes
 * here. `page` is null until the person gives the address of their own server, for an integration with `address`.
 */
@Composable
private fun SignInForm(workspaceId: String, integration: Integration, page: String?, onDismiss: () -> Unit, added: (Credential) -> Unit) {
    val session = LocalSession.current
    val context = LocalContext.current
    var started by remember { mutableStateOf(page) }
    var server by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    val signInPage = started
    if (signInPage == null) {
        BusyDialog("Connect ${integration.name}", "Continue", onDismiss, enabled = server.isNotBlank(), act = {
            started = session.api.connectIntegration(workspaceId, integration.id, server.trim()).url
        }, dismissOnSuccess = false) {
            GolemTextField(server, { server = it }, label = "Address", placeholder = "http://my-mac:3774", autofocus = true,
                keyboardOptions = webAddress)
        }
    } else {
        BusyDialog("Connect ${integration.name}", "Connect", onDismiss, enabled = address.isNotBlank(), act = {
            added(session.api.finishSignIn(workspaceId, integration.id, address.trim()))
            session.show("${integration.name} connected", Toast.Tone.Success)
        }) {
            GolemButton("Sign in to ${integration.name}", { openInTab(context, signInPage) }, size = ButtonSize.Large)
            GolemTextField(address, { address = it }, label = "Address after sign-in", keyboardOptions = webAddress)
        }
    }
}

/** Links a phone number with a code that the person enters on their phone, in Linked devices. */
@Composable
private fun LinkForm(workspaceId: String, integration: Integration, onDismiss: () -> Unit, added: (Credential) -> Unit) {
    val session = LocalSession.current
    var phone by remember { mutableStateOf("") }
    var code by remember { mutableStateOf<String?>(null) }
    val shownCode = code
    BusyDialog(
        "Link ${integration.name}", if (shownCode == null) "Get code" else "Done", onDismiss, enabled = phone.isNotBlank(),
        dismissOnSuccess = shownCode != null,
        act = {
            if (shownCode == null) {
                code = session.api.linkIntegration(workspaceId, integration.id, phone.trim()).code
            } else {
                added(session.api.finishLink(workspaceId, integration.id))
                session.show("${integration.name} connected", Toast.Tone.Success)
            }
        },
    ) {
        if (shownCode != null) {
            Text("Enter in Linked devices › Link with phone number", style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium),
                color = Golem.mobile.textSecondary)
            androidx.compose.foundation.text.selection.SelectionContainer {
                Text(shownCode, style = golemText(Tokens.FontSize.xxl, Tokens.FontWeight.semibold), color = Golem.mobile.text)
            }
        } else {
            GolemTextField(phone, { phone = it }, label = "Phone number", placeholder = "+420 123 456 789", autofocus = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone))
        }
    }
}

@Composable
private fun CredentialForm(workspaceId: String, integration: Integration, onDismiss: () -> Unit, added: (Credential) -> Unit) {
    val session = LocalSession.current
    var label by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    val complete = value.isNotEmpty() && (!integration.labeled || label.isNotBlank()) &&
        (!integration.address || address.isNotBlank()) && (integration.username == null || username.isNotBlank())
    BusyDialog("Add ${integration.name} credential", "Add", onDismiss, enabled = complete, act = {
        val fields = buildMap {
            put("secret", value)
            if (integration.labeled) put("label", label.trim())
            if (integration.address) put("address", address.trim())
            if (integration.username != null) put("username", username.trim())
        }
        added(session.api.addCredential(workspaceId, integration.id, fields))
        session.show("Credential added", Toast.Tone.Success)
    }) {
        if (integration.labeled) GolemTextField(label, { label = it }, label = "Label", autofocus = true)
        integration.username?.let { name ->
            GolemTextField(username, { username = it }, label = name, autofocus = !integration.labeled,
                keyboardOptions = plain.copy(keyboardType = KeyboardType.Email))
        }
        if (integration.address) GolemTextField(address, { address = it }, label = "Address", keyboardOptions = webAddress)
        GolemTextField(value, { value = it }, label = integration.secretLabel ?: "Secret", secure = true,
            autofocus = !integration.labeled && integration.username == null, keyboardOptions = secret)
    }
}

/** The OAuth client that Golem signs in to an integration with, which the server's owner sets. */
@Composable
private fun ClientForm(integration: Integration, onDismiss: () -> Unit, saved: suspend () -> Unit) {
    val session = LocalSession.current
    var clientId by remember { mutableStateOf(integration.client?.clientId ?: "") }
    var clientSecret by remember { mutableStateOf("") }
    BusyDialog("${integration.name} OAuth client", "Save", onDismiss, enabled = clientId.isNotBlank() && clientSecret.isNotEmpty(), act = {
        session.api.setIntegrationClient(integration.id, clientId.trim(), clientSecret)
        session.show("${integration.name} client saved", Toast.Tone.Success)
        saved()
    }) {
        GolemTextField(clientId, { clientId = it }, label = "Client ID", autofocus = true, keyboardOptions = plain)
        GolemTextField(clientSecret, { clientSecret = it }, label = "Client secret", secure = true, keyboardOptions = secret)
    }
}

/** The steps that set up an integration, numbered; links open, and a long press copies a step. */
@Composable
private fun Guide(integration: Integration, onDismiss: () -> Unit) {
    GolemDialog("Set up ${integration.name}", onDismiss, actions = {
        GolemButton("Done", onDismiss, variant = ButtonVariant.Primary)
    }) {
        Column(
            Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(Tokens.Space.lg),
        ) {
            integration.guide.forEachIndexed { index, step ->
                Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md)) {
                    Text("${index + 1}.", style = golemText(Tokens.FontSize.sm, Tokens.FontWeight.book), color = Golem.mobile.textTertiary,
                        modifier = Modifier.padding(top = 1.dp))
                    Copyable(step) { MarkdownText(step, size = Tokens.FontSize.sm) }
                }
            }
        }
    }
}
