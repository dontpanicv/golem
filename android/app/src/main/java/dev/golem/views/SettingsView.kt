package dev.golem.views

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.golem.api.ApiException
import dev.golem.api.Llm
import dev.golem.api.Toast
import dev.golem.api.llm
import dev.golem.api.llmLogin
import dev.golem.api.llmLogout
import dev.golem.api.restartServer
import dev.golem.api.setEffort
import dev.golem.api.setModel
import dev.golem.design.Badge
import dev.golem.design.ButtonSize
import dev.golem.design.ButtonVariant
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemMenu
import dev.golem.design.ListSectionHeader
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.PersonAvatar
import dev.golem.design.SettingsRow
import dev.golem.design.Tokens
import dev.golem.design.Tone
import dev.golem.design.golemText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * The person's integrations, places, what Golem learned, machines, the use of the model, the LLM provider, which the
 * whole server shares and only its owner changes, and the account, most used first, as one list of flat groups as
 * Linear's Android settings. It opens over the tabs.
 */
@Composable
fun SettingsView() {
    val session = LocalSession.current
    var llm by remember { mutableStateOf<Llm?>(null) }
    fun update(request: suspend () -> Llm) = session.launch { llm = request() }

    LaunchedEffect(Unit) { session.run { llm = session.api.llm() } }
    // While a device login waits, ask every 2 seconds until it connects or stops.
    LaunchedEffect(llm?.login?.userCode) {
        while (llm?.let { it.login != null && !it.connected } == true) {
            delay(2_000)
            runCatching { session.api.llm() }.getOrNull()?.let { llm = it }
        }
    }

    SettingsScreen("Settings") {
        session.workspace?.id?.let { workspaceId ->
            IntegrationsSection(workspaceId)
            PlacesSection(workspaceId)
            LearnedSection(workspaceId)
            MachinesSection(workspaceId)
            UsageSection(workspaceId)
        }
        SettingsGroup("LLM provider") {
            val current = llm
            if (current == null) SettingsLoading() else LlmRows(current, ::update)
        }
        if (llm?.owner == true) {
            SettingsGroup("Server") {
                SettingsRow("Configuration") {
                    GolemButton("Reload", {
                        session.launch {
                            session.api.restartServer()
                            session.show("Golem restarts", Toast.Tone.Success)
                        }
                    }, size = ButtonSize.Small)
                }
            }
        }
        session.user?.let { user ->
            SettingsGroup("Account") {
                SettingsRow(user.name, description = user.email, leading = { PersonAvatar(user.name, user.picture, 32.dp) }) {
                    PictureMenu(user.picture != null)
                }
            }
        }
        SettingsRow(
            "Sign out", labelColor = Golem.mobile.danger, onClick = { session.launch { session.signOut() } },
        ) {
            Icon(Icons.AutoMirrored.Outlined.Logout, null, Modifier.size(18.dp), tint = Golem.mobile.danger)
        }
    }
}

/** The provider's state; the server's owner connects it with a device code and picks the model and the effort. */
@Composable
private fun LlmRows(llm: Llm, update: (suspend () -> Llm) -> Unit) {
    val session = LocalSession.current
    SettingsRow(llm.provider, description = llm.error, descriptionColor = Golem.mobile.danger) {
        when {
            llm.connected -> {
                Badge("Connected", Tone.Success)
                if (llm.owner) GolemButton("Disconnect", { update { session.api.llmLogout() } }, size = ButtonSize.Small)
            }
            !llm.owner -> Badge("Not connected")
            llm.login != null -> Badge("Waiting", Tone.Warning)
            else -> GolemButton("Connect", { update { session.api.llmLogin() } }, variant = ButtonVariant.Primary, size = ButtonSize.Small)
        }
    }
    val login = llm.login
    if (!llm.connected && login != null) DeviceLogin(login)
    if (!llm.connected) return
    val modelName = llm.models.firstOrNull { it.id == llm.model }?.name ?: llm.model
    SettingsRow("Model") {
        if (llm.owner) {
            SettingsSelect(modelName, llm.models.map { model ->
                MenuAction(model.name, checked = model.id == llm.model) { update { session.api.setModel(model.id) } }
            })
        } else {
            SettingsValue(modelName)
        }
    }
    SettingsRow("Effort") {
        if (llm.owner) {
            SettingsSelect(effortLabel(llm.effort), llm.models.firstOrNull { it.id == llm.model }?.efforts.orEmpty().map { effort ->
                MenuAction(effortLabel(effort), checked = effort == llm.effort) { update { session.api.setEffort(effort) } }
            })
        } else {
            SettingsValue(effortLabel(llm.effort))
        }
    }
}

private fun effortLabel(effort: String) = if (effort == "xhigh") "Extra high" else effort.replaceFirstChar { it.uppercase() }

/** The code that the owner enters at the provider's page to connect it. */
@Composable
private fun DeviceLogin(login: Llm.Login) {
    val session = LocalSession.current
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val host = Uri.parse(login.verificationUri).host ?: login.verificationUri
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.lg),
        verticalArrangement = Arrangement.spacedBy(Tokens.Space.lg),
    ) {
        Text("Enter this code at $host", style = golemText(Tokens.FontSize.sm, Tokens.FontWeight.book), color = Golem.mobile.textTertiary)
        SelectionContainer {
            Text(login.userCode, style = golemText(Tokens.FontSize.xxl, Tokens.FontWeight.semibold).copy(fontFamily = FontFamily.Monospace),
                color = Golem.mobile.text)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space.lg)) {
            GolemButton("Copy code", {
                clipboard.setText(AnnotatedString(login.userCode))
                session.show("Copied", Toast.Tone.Success)
            })
            GolemButton("Open $host", { openInTab(context, login.verificationUri) }, variant = ButtonVariant.Primary)
        }
    }
}

/** Uploads a picture from the photo picker as the person's profile picture, or removes it. */
@Composable
private fun PictureMenu(hasPicture: Boolean) {
    val session = LocalSession.current
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) session.launch { session.setPicture(squarePicture(context, uri)) }
    }
    SettingsRowMenu("Picture actions", buildList {
        add(MenuAction("Upload picture", Icons.Outlined.PhotoLibrary) {
            picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        })
        if (hasPicture) add(MenuAction("Remove picture", Icons.Outlined.Delete, danger = true) { session.launch { session.setPicture(null) } })
    })
}

/** The longest side of a profile picture that the app uploads, in pixels, as the web app sends it. */
private const val PICTURE_SIZE = 256

/** The middle square of a picture as a small JPEG, so every app shows it round and the upload stays small. */
private suspend fun squarePicture(context: Context, uri: Uri): File = withContext(Dispatchers.IO) {
    val decoded = try {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
            val side = minOf(info.size.width, info.size.height)
            if (side > PICTURE_SIZE) {
                decoder.setTargetSize(info.size.width * PICTURE_SIZE / side, info.size.height * PICTURE_SIZE / side)
            }
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
    } catch (_: Exception) {
        throw ApiException(0, "Golem cannot read this picture.")
    }
    val side = minOf(decoded.width, decoded.height)
    val square = Bitmap.createBitmap(decoded, (decoded.width - side) / 2, (decoded.height - side) / 2, side, side)
    File(context.cacheDir, "${UUID.randomUUID()}.jpg").also { file ->
        file.outputStream().use { square.compress(Bitmap.CompressFormat.JPEG, 90, it) }
    }
}

// The parts of the settings screens

/** A settings screen: the bar, then its groups in one list that scrolls. */
@Composable
fun SettingsScreen(title: String, caption: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Scaffold(containerColor = Golem.mobile.background, topBar = { ScreenBar(title, caption) }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState())
                .padding(bottom = Tokens.Space.xxxl),
            content = content,
        )
    }
}

/** A flat group of settings rows under a small heading, as Linear's Android settings. */
@Composable
fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.padding(top = Tokens.Space.lg)) {
        ListSectionHeader(title)
        content()
    }
}

/** A spinner in a row's height, while a group loads. */
@Composable
fun SettingsLoading() {
    Box(Modifier.fillMaxWidth().heightIn(min = Tokens.Mobile.Size.settingsRow), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(18.dp), color = Golem.colors.accent, strokeWidth = 2.dp)
    }
}

/** A row's value that the person does not change here. */
@Composable
fun SettingsValue(text: String) {
    Text(text, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book), color = Golem.mobile.textTertiary)
}

/** A dim row, such as "Nothing yet". */
@Composable
fun SettingsEmptyRow(text: String) {
    SettingsRow(text, labelColor = Golem.mobile.textTertiary)
}

/** The ghost button under a group's rows that adds one, such as "Add place". */
@Composable
fun SettingsAddButton(label: String, onClick: () -> Unit) {
    Row(Modifier.padding(horizontal = Tokens.Space.md)) {
        GolemButton(label, onClick, variant = ButtonVariant.Ghost, size = ButtonSize.Small, icon = Icons.Outlined.Add)
    }
}

/** The "…" button of a row, which opens its actions. */
@Composable
fun SettingsRowMenu(label: String, items: List<MenuAction>) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton({ expanded = true }) { Icon(Icons.Outlined.MoreHoriz, label, tint = Golem.mobile.textSecondary) }
        GolemMenu(expanded, { expanded = false }, items)
    }
}

/** A select: the current option's name with a chevron, whose menu checks the current one. */
@Composable
fun SettingsSelect(current: String, options: List<MenuAction>) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.clip(RoundedCornerShape(Tokens.Radius.md)).clickable { expanded = true }
                .heightIn(min = 48.dp).padding(horizontal = Tokens.Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space.xs),
        ) {
            SettingsValue(current)
            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp), tint = Golem.mobile.textTertiary)
        }
        GolemMenu(expanded, { expanded = false }, options)
    }
}

/** Opens a web page in a Custom Tab over the app. */
fun openInTab(context: Context, url: String) {
    CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
}
