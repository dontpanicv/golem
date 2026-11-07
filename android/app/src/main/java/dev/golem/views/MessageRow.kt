package dev.golem.views

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.SubcomposeAsyncImage
import dev.golem.api.FileRef
import dev.golem.api.Message
import dev.golem.api.Step
import dev.golem.api.Work
import dev.golem.design.FileChip
import dev.golem.design.FileChips
import dev.golem.design.Golem
import dev.golem.design.GolemFace
import dev.golem.design.GolemMark
import dev.golem.design.LocalSession
import dev.golem.design.Mood
import dev.golem.design.PersonAvatar
import dev.golem.design.PixelSpinner
import dev.golem.design.Tokens
import dev.golem.design.golemText
import dev.golem.design.shimmer
import dev.golem.design.ticking
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

/**
 * One message, as Slack shows it: the author's avatar at the side, their name and the time over the text. A message
 * that follows one of the same author within five minutes shows only its text. Golem's face shows the mood of its
 * answer; `waiting` says that it waits for a person to allow an action of this answer's work.
 */
@Composable
fun MessageRow(message: Message, continued: Boolean, waiting: Boolean, openFile: (FileRef) -> Unit) {
    val session = LocalSession.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Tokens.Space.lg)) {
        val avatar = Tokens.Mobile.Size.avatar
        when {
            continued -> Spacer(Modifier.width(avatar))
            message.agent -> mood(message, waiting)?.let { GolemFace(it, avatar) } ?: GolemMark(avatar)
            else -> PersonAvatar(message.author, message.authorId?.let { session.pictures[it] }, avatar)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
            if (!continued) {
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm)) {
                    Text(message.author, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.semibold), color = Golem.mobile.title)
                    Text(time(message.time), style = golemText(Tokens.Mobile.FontSize.caption), color = Golem.mobile.textQuaternary,
                        modifier = Modifier.padding(bottom = 1.dp))
                }
            }
            message.work?.let { WorkLog(it) }
            if (message.text.isNotEmpty()) {
                Copyable(message.text) {
                    // Only a message with a thread link redraws when a thread starts or stops working.
                    MarkdownText(
                        message.text, working = if (message.text.contains("thread:")) session.working else emptySet(),
                        color = if (message.failed) Golem.mobile.danger else Golem.mobile.text,
                    )
                }
            }
            message.files.filter { it.isPicture }.forEach { FilePicture(it) { openFile(it) } }
            val others = message.files.filterNot { it.isPicture }
            if (others.isNotEmpty()) FileChips(others.map { it.name }, open = { openFile(others[it]) })
        }
    }
}

/** The face of an agent's message: it failed, it works or waits for a person, or it finished its work. */
fun mood(message: Message, waiting: Boolean): Mood? = when {
    message.failed -> Mood.Failed
    message.streaming || (message.work != null && message.work.endedAt == null) -> if (waiting) Mood.Waiting else Mood.Working
    message.work != null -> if (message.work.stopped) null else Mood.Done
    else -> null
}

/** The step of a turn that another thread's message started. */
const val RELAY = "from_thread"

/**
 * The message follows one of the same author within five minutes, and has no work log to head; or it is a turn of
 * Golem that the answer of another thread started.
 */
fun continues(message: Message, previous: Message): Boolean {
    if (message.agent && previous.agent && relayedFrom(message) != null) return true
    return message.author == previous.author && message.agent == previous.agent && message.work == null &&
        message.time - previous.time < 5 * 60 * 1000
}

/** The title of the thread whose message started this turn, or null for a turn that a person started. */
fun relayedFrom(message: Message): String? =
    message.work?.steps?.firstOrNull()?.takeIf { it.tool == RELAY }?.let { linkedText(it.text) }

private val PICTURES = setOf("jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "avif")

val FileRef.isPicture: Boolean get() = name.substringAfterLast('.', "").lowercase() in PICTURES

private fun time(milliseconds: Double): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(milliseconds.toLong()))

/** A picture of a message, from its JPEG, at most 320 wide and 240 high; a tap opens it. */
@Composable
private fun FilePicture(file: FileRef, open: () -> Unit) {
    val session = LocalSession.current
    val workspace = session.workspace ?: return
    val shape = RoundedCornerShape(Tokens.Radius.md)
    SubcomposeAsyncImage(
        session.api.pictureUrl(workspace.id, file.id), contentDescription = file.name, contentScale = ContentScale.Fit,
        loading = { Box(Modifier.size(180.dp, 135.dp).background(Golem.colors.fillSubtle, shape)) },
        error = { FileChip(file.name, onClick = open) },
        modifier = Modifier.sizeIn(maxWidth = 320.dp, maxHeight = 240.dp).clip(shape)
            .border(0.5.dp, Golem.colors.ring, shape).clickable(onClick = open),
    )
}

// The work log

/**
 * The work before an answer: open while the agent works, then folded into "Worked for …". A person's choice to open
 * or fold it lasts until the work ends. A long log scrolls and keeps its newest step in view; calls of one tool in a
 * row fold into one row.
 */
@Composable
fun WorkLog(work: Work) {
    val working = work.endedAt == null
    var chosen by remember(working) { mutableStateOf<Boolean?>(null) }
    val open = chosen ?: working
    val turn by animateFloatAsState(if (open) 90f else 0f, label = "chevron")
    val now = ticking(working)
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
        Row(
            Modifier.heightIn(min = 32.dp).clip(RoundedCornerShape(Tokens.Radius.sm))
                .clickable(enabled = work.steps.isNotEmpty()) { chosen = !open },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space.xs),
        ) {
            val style = golemText(Tokens.FontSize.md).copy(color = Golem.colors.textTertiary)
            if (working) PixelSpinner(Modifier.padding(end = Tokens.Space.xs))
            val span = duration(((work.endedAt ?: now.toDouble()) - work.startedAt) / 1000)
            Text(label(work, span), style = if (working) shimmer(style) else style, maxLines = 1)
            if (working) {
                stepTitle(work.steps.lastOrNull())?.let {
                    Text("· $it", style = style.copy(color = Golem.colors.textQuaternary), maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false))
                }
            }
            if (work.steps.isNotEmpty()) {
                Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, if (open) "Fold" else "Open", Modifier.size(16.dp).rotate(turn),
                    tint = Golem.colors.textTertiary)
            }
            if (!working) StepStrip(work.steps)
        }
        AnimatedVisibility(open && work.steps.isNotEmpty()) {
            val scroll = rememberScrollState()
            LaunchedEffect(work.steps.size, scroll.maxValue) { if (working) scroll.scrollTo(scroll.maxValue) }
            val line = Golem.colors.border
            Column(
                Modifier.heightIn(max = Tokens.Size.workLog)
                    .drawBehind { drawLine(line, Offset.Zero, Offset(0f, size.height), 1.dp.toPx()) }
                    .padding(start = Tokens.Space.md).verticalScroll(scroll),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs),
            ) {
                runs(work.steps).forEach { run -> if (run.size == 1) WorkStep(run[0]) else WorkGroup(run) }
            }
        }
    }
}

private fun label(work: Work, span: String): String = when {
    work.endedAt == null -> "Working for $span"
    work.stopped -> "Stopped after $span"
    work.steps.firstOrNull()?.tool == RELAY -> "From ${linkedText(work.steps.first().text)}"
    else -> "Worked for $span"
}

/** The step the agent is at: the tool it calls, a thought, or the words of its answer. */
fun stepTitle(step: Step?): String? = when (step?.kind) {
    null -> null
    "tool" -> toolName(step.tool)
    "thinking" -> "Thinking"
    else -> "Writing"
}

/** The steps in runs: each call of a tool that the call before it also made joins that call's run. */
fun runs(steps: List<Step>): List<List<Step>> {
    val result = mutableListOf<MutableList<Step>>()
    for (step in steps) {
        val last = result.lastOrNull()
        if (step.kind == "tool" && last != null && last[0].tool == step.tool) last.add(step) else result.add(mutableListOf(step))
    }
    return result
}

/** A time span as 8s, 2m 05s, or 1h 03m, as the web writes it. */
fun duration(seconds: Double): String {
    val whole = maxOf(0, seconds.toInt())
    val minutes = whole / 60
    return when {
        minutes == 0 -> "${whole}s"
        minutes < 60 -> "${minutes}m %02ds".format(whole % 60)
        else -> "${minutes / 60}h %02dm".format(minutes % 60)
    }
}

/** A tool's name as words: `web_search` is Web search. */
fun toolName(tool: String?): String = (tool ?: "").replace('_', ' ').replaceFirstChar { it.uppercase() }

/** The pixel of tool calls: gold when they finished, `danger` when one failed, and the blinking accent while one runs. */
@Composable
private fun StepPixel(steps: List<Step>) {
    if (steps.any { it.running }) {
        var lit by remember { mutableStateOf(true) }
        LaunchedEffect(Unit) {
            while (true) {
                delay(500)
                lit = !lit
            }
        }
        Box(Modifier.size(7.dp).graphicsLayer { alpha = if (lit) 1f else 0.25f }.background(Golem.colors.accent))
    } else {
        Box(Modifier.size(7.dp).background(if (steps.any { it.failed }) Golem.colors.danger else Golem.colors.gold))
    }
}

/** One pixel for each tool call of a finished work. */
@Composable
private fun StepStrip(steps: List<Step>) {
    // shortcut: a long work shows only its last 24 calls; open the log for all of them.
    val calls = steps.filter { it.kind == "tool" && it.tool != RELAY }.takeLast(24)
    Row(Modifier.padding(start = Tokens.Space.xs), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        calls.forEach { StepPixel(listOf(it)) }
    }
}

/** Calls of one tool in a row: the tool's name and how many calls, which opens to show each call. */
@Composable
private fun WorkGroup(steps: List<Step>) {
    var chosen by remember { mutableStateOf<Boolean?>(null) }
    val open = chosen ?: steps.any { it.running }
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
        Row(
            Modifier.clickable { chosen = !open }, verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm),
        ) {
            StepPixel(steps)
            Text(toolName(steps[0].tool), style = golemText(Tokens.FontSize.md, Tokens.FontWeight.medium), color = Golem.colors.textTertiary)
            Text("${steps.size} times", style = golemText(Tokens.FontSize.md), color = Golem.colors.textQuaternary)
        }
        if (open) {
            Column(Modifier.padding(start = Tokens.Space.md), verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
                steps.forEach { WorkStep(it) }
            }
        }
    }
}

/**
 * A thought, the words between tool calls, or a tool call: its name, then the thread it reached or the values of its
 * arguments. Tapping a tool call shows its arguments and result.
 */
@Composable
private fun WorkStep(step: Step) {
    val session = LocalSession.current
    when (step.kind) {
        "tool" -> {
            var open by remember { mutableStateOf(false) }
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
                Row(
                    Modifier.fillMaxWidth().clickable { open = !open }, verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm),
                ) {
                    StepPixel(listOf(step))
                    Text(toolName(step.tool), style = golemText(Tokens.FontSize.md, Tokens.FontWeight.medium),
                        color = if (step.failed) Golem.colors.danger else Golem.colors.textTertiary)
                    Text(linkedText(step.text), style = golemText(Tokens.FontSize.md), color = Golem.colors.textQuaternary,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (open) {
                    listOfNotNull(step.input, step.output).filter { it.isNotEmpty() && it != "{}" }.forEach {
                        Copyable(it) {
                            Text(
                                it, style = golemText(Tokens.FontSize.sm).copy(fontFamily = FontFamily.Monospace),
                                color = Golem.colors.textTertiary,
                                modifier = Modifier.fillMaxWidth().background(Golem.colors.fillSubtle, RoundedCornerShape(Tokens.Radius.sm))
                                    .padding(horizontal = Tokens.Space.md, vertical = Tokens.Space.sm),
                            )
                        }
                    }
                }
            }
        }
        "thinking" -> Text(step.text, style = golemText(Tokens.FontSize.md), color = Golem.colors.textQuaternary)
        else -> Copyable(step.text) {
            MarkdownText(step.text, Tokens.FontSize.md, session.working, Golem.colors.textSecondary)
        }
    }
}

