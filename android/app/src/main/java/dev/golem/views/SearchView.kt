package dev.golem.views

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import dev.golem.api.Destination
import dev.golem.api.FileRef
import dev.golem.api.RecentSearch
import dev.golem.api.SearchResponse
import dev.golem.api.SearchResult
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.EmptyState
import dev.golem.design.Golem
import dev.golem.design.GolemTextField
import dev.golem.design.ListRow
import dev.golem.design.LocalSession
import dev.golem.design.Tokens
import dev.golem.design.golemText
import dev.golem.design.pressable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Searches the open workspace, never another, from a field at the top as Slack's search; results update as the person
 * types. Before a query it lists the person's recent searches, then Golem.
 */
@Composable
fun SearchView() {
    val session = LocalSession.current
    val open = LocalOpen.current
    val openFile = rememberFileOpener()
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val list = rememberLazyListState()
    var query by rememberSaveable { mutableStateOf("") }
    var response by remember { mutableStateOf<SearchResponse?>(null) }
    var recent by remember { mutableStateOf<List<RecentSearch>>(emptyList()) }
    val blank = query.isBlank()

    // The recent searches are only a help, so a failure stays quiet.
    fun save() {
        val text = query.trim()
        val workspace = session.workspace ?: return
        if (text.isEmpty()) return
        scope.launch { quietly { session.api.saveSearch(workspace.id, text) }?.let { recent = it.searches } }
    }

    fun show(result: SearchResult) {
        save()
        val file = savedFile(result.uri)
        when {
            result.kind == "artifact" -> open(Destination.Artifact(result.channelId, result.uri.removePrefix("artifact:")))
            file != null -> openFile(file)
            result.kind == "thread" && result.threadId != null -> open(Destination.Thread(result.threadId))
        }
    }

    LaunchedEffect(session.workspace?.id) {
        val workspace = session.workspace ?: return@LaunchedEffect
        quietly { session.api.recentSearches(workspace.id) }?.let { recent = it.searches }
    }
    LaunchedEffect(query) {
        // Waits for a pause in typing; a new keystroke cancels this effect.
        delay(200)
        val workspace = session.workspace ?: return@LaunchedEffect
        if (query.isBlank()) {
            response = null
            return@LaunchedEffect
        }
        response = quietly { session.api.search(workspace.id, query) }
        // A search counts once its results rest a second, so the words typed on the way to it do not.
        if (response?.results.isNullOrEmpty()) return@LaunchedEffect
        delay(1000)
        save()
    }
    // Scrolling closes the keyboard.
    LaunchedEffect(list.isScrollInProgress) { if (list.isScrollInProgress) focus.clearFocus() }

    Scaffold(containerColor = Golem.mobile.background, topBar = { ScreenBar("Search") }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            GolemTextField(
                query, { query = it }, placeholder = "Search ${session.workspace?.name ?: ""}", large = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onSearch = {
                    save()
                    focus.clearFocus()
                }),
                modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md),
            )
            Box(Modifier.weight(1f)) {
                LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = dev.golem.design.ListPadding) {
                    if (blank) {
                        items(recent, key = { "recent:${it.query}" }) { search ->
                            ListRow(search.query, icon = Pixel.Clock.vector, onClick = { query = search.query }) {
                                Text(relative(search.searchedAt), style = golemText(Tokens.Mobile.FontSize.caption),
                                    color = Golem.mobile.textQuaternary)
                            }
                        }
                        session.orchestrator?.let { orchestrator ->
                            item(key = "golem") { ListRow("Golem", golem = true, onClick = { open(Destination.Thread(orchestrator.id)) }) }
                        }
                    } else {
                        if (response?.semantic == false) {
                            item(key = "words") {
                                Text(
                                    "Matching words only while the search model starts.",
                                    style = golemText(Tokens.Mobile.FontSize.small), color = Golem.mobile.textTertiary,
                                    modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.sm),
                                )
                            }
                        }
                        items(response?.results.orEmpty(), key = { it.uri }) { result ->
                            val opens = result.kind == "artifact" || result.kind == "thread" || savedFile(result.uri) != null
                            SearchRow(
                                result, session.channels.firstOrNull { it.id == result.channelId }?.name,
                                onClick = if (opens) ({ show(result) }) else null,
                                modifier = Modifier.animateItem(),
                            )
                        }
                    }
                }
                if (!blank && response?.results?.isEmpty() == true) {
                    EmptyState("Nothing found")
                }
            }
        }
    }
}

/** Runs a read whose failure stays quiet; a cancellation still stops the caller. */
suspend fun <T> quietly(read: suspend () -> T): T? = try {
    read()
} catch (error: CancellationException) {
    throw error
} catch (_: Exception) {
    null
}

private val SAVED_FILE = Regex("^(?:channels/[^/]+/)?files/([0-9a-f-]{36})-(.+)$")

/** A file Golem saved: `channels/<channel>/files/<uuidv7>-<name>`, or `files/<uuidv7>-<name>` of the workspace. */
fun savedFile(uri: String): FileRef? = SAVED_FILE.find(uri)?.let { FileRef(it.groupValues[1], it.groupValues[2]) }

/** A result: the icon of its kind, its title, its snippet, and where and when. */
@Composable
private fun SearchRow(result: SearchResult, channel: String?, onClick: (() -> Unit)?, modifier: Modifier = Modifier) {
    val icon = when (result.kind) {
        "thread" -> Pixel.Compose.vector
        "artifact" -> Pixel.Artifact.vector
        "capture" -> Pixel.Inbox.vector
        else -> Pixel.File.vector
    }
    val day = shortDay(result.updatedAt)
    Row(
        modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 1.5.dp).clip(RoundedCornerShape(Tokens.Radius.xl))
            .then(if (onClick != null) Modifier.pressable(onClick) else Modifier.alpha(0.6f))
            .heightIn(min = Tokens.Mobile.Size.row).padding(horizontal = 10.dp, vertical = Tokens.Space.md),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md),
    ) {
        Box(Modifier.width(21.dp).padding(top = 2.dp), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = Golem.mobile.textSecondary)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(result.title, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book), color = Golem.mobile.text)
            if (result.snippet.isNotEmpty()) {
                MarkdownText(result.snippet, size = Tokens.Mobile.FontSize.small, color = Golem.mobile.textSecondary)
            }
            Text(channel?.let { "#$it · $day" } ?: day, style = golemText(Tokens.Mobile.FontSize.caption),
                color = Golem.mobile.textQuaternary)
        }
    }
}
