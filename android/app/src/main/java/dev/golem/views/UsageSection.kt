package dev.golem.views

import android.icu.text.CompactDecimalFormat
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import dev.golem.api.Destination
import dev.golem.api.Usage
import dev.golem.api.UsageTotals
import dev.golem.api.usage
import dev.golem.design.Golem
import dev.golem.design.GolemMark
import dev.golem.design.ListSubheading
import dev.golem.design.LocalSession
import dev.golem.design.PersonAvatar
import dev.golem.design.SettingsRow
import dev.golem.design.Tokens
import java.text.NumberFormat
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Currency
import java.util.Locale

/** The days of use that the section shows. */
private const val DAYS = 30

/**
 * The use of the model in the last 30 days: the person's own, or everyone's for the server's owner. The cost is at the
 * model's list price, which a ChatGPT login does not pay. A chat opens on a tap.
 */
@Composable
fun UsageSection(workspaceId: String) {
    val session = LocalSession.current
    val open = LocalOpen.current
    var usage by remember { mutableStateOf<Usage?>(null) }

    LaunchedEffect(workspaceId) { session.run { usage = session.api.usage(workspaceId, DAYS) } }

    SettingsGroup("Usage") {
        val current = usage ?: return@SettingsGroup SettingsLoading()
        SettingsRow("Tokens", description = "Last $DAYS days") { SettingsValue(tokens(current.total.tokens)) }
        SettingsRow("Cost at API prices") { SettingsValue(cost(current.total.cost)) }
        SettingsRow("Cache rate") { SettingsValue(NumberFormat.getPercentInstance().format(current.total.cacheRate)) }
        DayBars(current.days)
        // The same groups as the web's: sub-headings in the section.
        UsageGroup("By source", current.sources) { sourceName(it.source) }
        UsageGroup("By model", current.models) { modelName(it.model) }
        if (current.chats.isNotEmpty()) {
            ListSubheading("Top chats")
            current.chats.forEach { chat ->
                SettingsRow(chat.title ?: "", description = "${tokens(chat.tokens)} tokens",
                    onClick = chat.chatId?.let { id -> { open(Destination.Chat(id)) } }) { SettingsValue(cost(chat.cost)) }
            }
        }
        val people = current.people
        if (!people.isNullOrEmpty()) {
            ListSubheading("By person")
            people.forEach { row ->
                SettingsRow(row.name ?: "", description = "${tokens(row.tokens)} tokens", leading = {
                    // Work for nobody is Golem's own.
                    if (row.userId.isNullOrEmpty()) GolemMark() else PersonAvatar(row.name ?: "", session.pictures[row.userId])
                }) { SettingsValue(cost(row.cost)) }
            }
        }
    }
}

@Composable
private fun UsageGroup(title: String, rows: List<UsageTotals>, name: (UsageTotals) -> String) {
    if (rows.isEmpty()) return
    ListSubheading(title)
    rows.forEach { row -> SettingsRow(name(row), description = "${tokens(row.tokens)} tokens") { SettingsValue(cost(row.cost)) } }
}

/** A small bar for each of the last 30 days in UTC, as tall as its tokens; a day without use has only a stub. */
@Composable
private fun DayBars(days: List<UsageTotals>) {
    val tokens = lastDays(DAYS, LocalDate.now(ZoneOffset.UTC)).map { day -> days.firstOrNull { it.day == day }?.tokens ?: 0.0 }
    val most = maxOf(tokens.max(), 1.0)
    val accent = Golem.colors.accent
    val empty = Golem.mobile.fill
    Canvas(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.md).height(Tokens.Size.control)
            .semantics { contentDescription = "Tokens by day" },
    ) {
        val gap = Tokens.Space.xxs.toPx()
        val width = (size.width - gap * (tokens.size - 1)) / tokens.size
        val stub = Tokens.Space.xxs.toPx()
        tokens.forEachIndexed { index, value ->
            val height = maxOf(stub, (size.height * value / most).toFloat())
            drawRoundRect(
                if (value > 0) accent else empty, Offset(index * (width + gap), size.height - height), Size(width, height),
                CornerRadius(Tokens.Radius.xxs.toPx()),
            )
        }
    }
}

/** "YYYY-MM-DD" of the last `count` days up to `today`, oldest first, as the server names its days in UTC. */
fun lastDays(count: Int, today: LocalDate): List<String> = (count - 1 downTo 0).map { today.minusDays(it.toLong()).toString() }

private fun tokens(count: Double): String =
    CompactDecimalFormat.getInstance(Locale.getDefault(), CompactDecimalFormat.CompactStyle.SHORT).format(count)

private fun cost(dollars: Double): String = NumberFormat.getCurrencyInstance().apply {
    currency = Currency.getInstance("USD")
    minimumFractionDigits = 2
    maximumFractionDigits = 2
}.format(dollars)

private fun sourceName(source: String?) = when (source) {
    "chat" -> "Chats"
    "orchestrator" -> "Golem"
    "routine" -> "Routines"
    "reminder" -> "Reminders"
    "intake" -> "Accounts"
    "background" -> "Briefs, memory, and names"
    else -> source ?: ""
}

/** "provider/model", or "tool:<name>" for a tool's own model calls. */
private fun modelName(model: String?) = model?.let { if (it.startsWith("tool:")) "Tool ${it.removePrefix("tool:")}" else it } ?: ""
