package dev.golem.views

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.MarkdownCodeFence
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.markdownAnnotator
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.Golem
import dev.golem.design.GolemMenu
import dev.golem.design.MenuAction
import dev.golem.design.PixelIcon
import dev.golem.design.PixelIcons
import dev.golem.design.Tokens
import dev.golem.design.golemText
import dev.golem.design.raisedCard
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes

/**
 * Markdown that an agent wrote, as the web shows it: headings, lists, quotes, code blocks, tables, and rules, with the
 * inline Markdown in each. A link takes the accent; a link to `chat:<id>` is followed by "working" while the agent
 * of that chat works. A fenced `card` block shows its cards, as the web's `cards.tsx` does.
 */
@Composable
fun MarkdownText(
    text: String,
    size: TextUnit = Tokens.Mobile.FontSize.body,
    working: Set<String> = emptySet(),
    color: Color = Golem.mobile.text,
    modifier: Modifier = Modifier,
) {
    val base = golemText(size).copy(color = color, lineHeight = 1.45.em)
    val mono = base.copy(fontFamily = FontFamily.Monospace, fontSize = Tokens.FontSize.md)
    val heading = base.copy(color = Golem.mobile.title, fontWeight = Tokens.FontWeight.semibold)
    val link = TextLinkStyles(SpanStyle(color = Golem.colors.accent))
    // Times, counts, and values in bold. Bold around a link keeps the library's own bold.
    val strong = SpanStyle(fontWeight = Tokens.FontWeight.semibold, color = Golem.mobile.title)
    val annotator = remember(strong) {
        markdownAnnotator(annotate = { content, child ->
            val inner = child.children.filter { it.type != MarkdownTokenTypes.EMPH }
            if (child.type != MarkdownElementTypes.STRONG || inner.isEmpty() || inner.any { it.children.isNotEmpty() }) {
                false
            } else {
                withStyle(strong) { append(content.substring(inner.first().startOffset, inner.last().endOffset)) }
                true
            }
        })
    }
    Markdown(
        annotator = annotator,
        content = withWorkingNotes(text, working),
        colors = markdownColor(
            text = color, codeBackground = Golem.colors.fillSubtle, inlineCodeBackground = Golem.colors.fillSubtle,
            dividerColor = Golem.colors.border, tableBackground = Color.Transparent,
        ),
        typography = markdownTypography(
            h1 = heading.copy(fontSize = size * 1.25f), h2 = heading, h3 = heading, h4 = heading, h5 = heading, h6 = heading,
            text = base, code = mono, inlineCode = base.copy(fontFamily = FontFamily.Monospace, fontSize = size * 0.9f),
            quote = base.copy(color = Golem.colors.textTertiary), paragraph = base, ordered = base, bullet = base, list = base,
            textLink = link, table = golemText(Tokens.Mobile.FontSize.small).copy(color = color),
        ),
        components = markdownComponents(
            codeFence = { model ->
                MarkdownCodeFence(model.content, model.node, mono) { code, language, style ->
                    val cards = if (language == "card") Card.parse(code) else null
                    if (cards != null) CardList(cards) else CodeBlock(code, style)
                }
            },
        ),
        modifier = modifier.fillMaxWidth(),
    )
}

/** Each chat link of a chat whose agent works, followed by "· working". */
fun withWorkingNotes(text: String, working: Set<String>): String {
    if (working.isEmpty() || !text.contains("chat:")) return text
    return CHAT_LINK.replace(text) { match ->
        if (match.groupValues[2] in working) "${match.value} *· working*" else match.value
    }
}

/** `[title](chat:<id>)`, as the agents write a link to a chat. */
val CHAT_LINK = Regex("""\[([^\]\n]+)\]\(chat:([\w-]+)\)""")

/** One line with the chat links as their titles, as a work step's text shows. */
fun linkedText(text: String): String = CHAT_LINK.replace(text) { it.groupValues[1] }

/** A long press shows Copy, which copies `text`; the text is not selectable, so its links answer every tap. */
@Composable
fun Copyable(text: String, content: @Composable () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    Box(Modifier.pointerInput(text) { detectTapGestures(onLongPress = { menu = true }) }) {
        content()
        GolemMenu(menu, { menu = false }, listOf(MenuAction("Copy", Pixel.Copy.vector) {
            clipboard.setText(AnnotatedString(text))
        }))
    }
}

/** A card that an agent writes for a value that matters: a fenced `card` block with one JSON object, or a list. */
@Serializable
data class Card(val value: String, val title: String? = null, val detail: String? = null, val icon: String? = null) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** The cards of a `card` block, or null when it is not valid, so that it shows as code. */
        fun parse(code: String): List<Card>? =
            runCatching { json.decodeFromString<List<Card>>(code).takeIf { it.isNotEmpty() } }.getOrNull()
                ?: runCatching { listOf(json.decodeFromString<Card>(code)) }.getOrNull()
    }
}

/** The cards of a `card` block, one in a row on a phone, so that a value fits on its line. */
@Composable
private fun CardList(cards: List<Card>) {
    Column(Modifier.fillMaxWidth().padding(vertical = Tokens.Space.xs), verticalArrangement = Arrangement.spacedBy(Tokens.Space.md)) {
        cards.forEach { card ->
            Row(
                Modifier.fillMaxWidth().raisedCard(Tokens.Radius.lg, ring = Golem.colors.ringControl)
                    .padding(horizontal = Tokens.Space.lg, vertical = Tokens.Space.md),
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space.lg),
                verticalAlignment = Alignment.Top,
            ) {
                card.icon?.let { PixelIcons.paths[it] }?.let { PixelIcon(it) }
                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    card.title?.let {
                        Text(it.uppercase(), style = golemText(Tokens.FontSize.xs, Tokens.FontWeight.medium).copy(letterSpacing = 0.4.em / 11),
                            color = Golem.mobile.textTertiary)
                    }
                    Text(card.value, style = golemText(Tokens.Mobile.FontSize.menu, Tokens.FontWeight.semibold), color = Golem.mobile.title)
                    card.detail?.let {
                        Text(it, style = golemText(Tokens.Mobile.FontSize.caption), color = Golem.mobile.textTertiary)
                    }
                }
            }
        }
    }
}


/** A code block, as the web shows it: monospaced on `fillSubtle`, scrolling sideways. */
@Composable
private fun CodeBlock(code: String, style: androidx.compose.ui.text.TextStyle) {
    Box(
        Modifier.fillMaxWidth().background(Golem.colors.fillSubtle, RoundedCornerShape(Tokens.Radius.md))
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Tokens.Space.lg, vertical = Tokens.Space.md),
    ) { Text(code, style = style) }
}
