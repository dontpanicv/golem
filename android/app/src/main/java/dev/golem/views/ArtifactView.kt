package dev.golem.views

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.golem.api.Api
import dev.golem.api.Artifact
import dev.golem.api.ArtifactDetail
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.Badge
import dev.golem.design.ButtonSize
import dev.golem.design.ButtonVariant
import dev.golem.design.EmptyState
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemMenu
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.SettingsRow
import dev.golem.design.Tone
import dev.golem.design.Tokens
import dev.golem.design.golemText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** An open artifact: a bar with its actions, then the artifact running, or the data it keeps. */
@Composable
fun ArtifactView(artifactId: String, changes: Int, changed: () -> Unit) {
    val session = LocalSession.current
    var detail by remember { mutableStateOf<ArtifactDetail?>(null) }
    var showData by remember { mutableStateOf(false) }
    LaunchedEffect(changes) { session.run { detail = session.api.artifact(artifactId) } }

    /** Runs an action, then loads the artifact and the chat's list again. */
    fun act(action: suspend () -> Unit) = session.launch {
        action()
        detail = session.api.artifact(artifactId)
        changed()
    }

    val current = detail ?: return
    Column(Modifier.fillMaxSize()) {
        ArtifactBar(current.artifact, showData, { showData = !showData },
            setVisibility = { act { session.api.setArtifactVisibility(artifactId, it) } },
            clearData = { act { session.api.deleteArtifactData(artifactId) } },
            delete = {
                session.launch {
                    session.api.deleteArtifact(artifactId)
                    detail = null
                    changed()
                }
            },
        )
        if (showData) {
            if (current.records.isEmpty()) {
                EmptyState("No data yet")
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(current.records, key = { it.id }) { record ->
                        val who = if (record.visitor == null) "Shared" else record.name ?: "Visitor"
                        SettingsRow(record.key, description = "$who · ${record.value.toString().take(200)}") {
                            IconButton({ act { session.api.deleteArtifactRecord(artifactId, record.id) } }) {
                                Icon(Pixel.Trash.vector, "Delete ${record.key}", tint = Golem.colors.textTertiary)
                            }
                        }
                    }
                }
            }
        } else {
            ArtifactWebView(artifactId, current.content) { call -> session.api.artifactRpc(artifactId, call) }
        }
    }
}

@Composable
private fun ArtifactBar(
    artifact: Artifact, showData: Boolean, toggleData: () -> Unit, setVisibility: (String) -> Unit, clearData: () -> Unit,
    delete: () -> Unit,
) {
    val session = LocalSession.current
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var menu by remember { mutableStateOf(false) }
    val public = artifact.visibility == "public"
    Row(
        Modifier.fillMaxWidth().padding(start = Tokens.Mobile.Size.margin, end = Tokens.Space.xs),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space.xs),
    ) {
        Text(artifact.title, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.medium), color = Golem.mobile.text,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Badge(if (public) "Public" else "Members", if (public) Tone.Accent else Tone.Neutral)
        GolemButton("Data", toggleData, variant = if (showData) ButtonVariant.Secondary else ButtonVariant.Ghost, size = ButtonSize.Small)
        IconButton({
            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, artifact.url), null))
        }) { Icon(Pixel.Share.vector, "Share", tint = Golem.colors.textTertiary) }
        Box {
            IconButton({ menu = true }) { Icon(Pixel.More.vector, "${artifact.title} actions", tint = Golem.colors.textTertiary) }
            GolemMenu(menu, { menu = false }, listOf(
                MenuAction("Open", Pixel.Preview.vector) {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(artifact.url))) }
                },
                MenuAction("Copy link", Pixel.Link.vector) {
                    clipboard.setText(AnnotatedString(artifact.url))
                    session.show("Copied", dev.golem.api.Toast.Tone.Success)
                },
                if (public) MenuAction("Make members only", Pixel.Lock.vector) { setVisibility("members") }
                else MenuAction("Make public", Pixel.Preview.vector) { setVisibility("public") },
                MenuAction("Clear data", Pixel.Inbox.vector, action = clearData),
                MenuAction("Delete", Pixel.Trash.vector, danger = true, action = delete),
            ))
        }
    }
}

/**
 * Runs an artifact's HTML at an origin of its own that no server has (`https://<id>.artifact.invalid`), so it never
 * runs as Golem's site and artifacts do not share their storage. Its `golem` runtime posts each call to
 * `window.webkit.messageHandlers.golem`, which a script at the document's start gives the main frame; only the main
 * frame of that origin is answered, through `window.__golemReceive`. A tapped https link opens in the browser, and
 * nothing else replaces the page.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun ArtifactWebView(artifactId: String, content: String, call: suspend (JsonObject) -> kotlinx.serialization.json.JsonElement) {
    val origin = "https://$artifactId.artifact.invalid"
    val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Main) }
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { scope.cancel() } }
    var loaded by remember { mutableStateOf<String?>(null) }
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url
                        if (request.isForMainFrame && request.hasGesture() && url.scheme == "https" && url.host != Uri.parse(origin).host) {
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url)) }
                        }
                        return true
                    }
                }
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) &&
                    WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                ) {
                    WebViewCompat.addDocumentStartJavaScript(this, SHIM, setOf(origin))
                    WebViewCompat.addWebMessageListener(this, "golemAndroid", setOf(origin)) { _, message: WebMessageCompat, source, isMainFrame, reply: JavaScriptReplyProxy ->
                        if (!isMainFrame || source.toString().trimEnd('/') != origin) return@addWebMessageListener
                        val body = runCatching { Json.parseToJsonElement(message.data ?: "").jsonObject }.getOrNull()
                            ?: return@addWebMessageListener
                        val id = body["id"]?.jsonPrimitive?.int ?: return@addWebMessageListener
                        val op = body["op"]?.jsonPrimitive?.content ?: return@addWebMessageListener
                        scope.launch {
                            val answer = runCatching {
                                call(Api.body("op" to op, "args" to (body["args"] ?: JsonObject(emptyMap()))))
                            }
                            val result = answer.fold(
                                { Api.body("golem" to 1, "id" to id, "result" to it) },
                                { Api.body("golem" to 1, "id" to id, "error" to JsonPrimitive(it.message ?: "Failed")) },
                            )
                            evaluateJavascript("window.__golemReceive($result)", null)
                        }
                    }
                }
            }
        },
        update = { view ->
            if (loaded != content) {
                loaded = content
                val html = if (VIEWPORT.containsMatchIn(content)) content else withViewport(content)
                view.loadDataWithBaseURL("$origin/", html, "text/html", "utf-8", null)
            }
        },
    )
}

/** The page's `golem` runtime calls the iOS web view's message handler; this gives it one that posts to the app. */
private const val SHIM = """window.webkit = { messageHandlers: { golem: { postMessage: (message) => golemAndroid.postMessage(JSON.stringify(message)) } } };"""

/** A page without a viewport would lay out 980 px wide and shrink to fit, as on a desktop. */
private val VIEWPORT = Regex("""<meta[^>]+name\s*=\s*["']?viewport""", RegexOption.IGNORE_CASE)

/** The page with a viewport after its doctype, so that it keeps the standards mode. */
fun withViewport(html: String): String {
    val meta = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    val doctype = Regex("^\\s*<!doctype[^>]*>", RegexOption.IGNORE_CASE).find(html) ?: return meta + html
    return html.substring(0, doctype.range.last + 1) + meta + html.substring(doctype.range.last + 1)
}
