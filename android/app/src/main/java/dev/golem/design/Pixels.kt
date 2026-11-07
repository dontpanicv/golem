package dev.golem.design

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * A shape from the cells of a pixel grid, written as the web writes it in SVG: absolute `M`, `H`, `V`, and `Z` only,
 * so that all apps draw the same strings. `inset` cells of the `cells` grid stay empty around it.
 */
fun pixelPath(path: String, size: Float, cells: Float = 8f, inset: Float = 0f, evenOdd: Boolean = false): Path {
    val scale = size / cells
    val result = Path().apply { if (evenOdd) fillType = PathFillType.EvenOdd }
    var x = 0f
    var y = 0f
    var startX = 0f
    var startY = 0f
    val tokens = Regex("[MHVZ]|-?[0-9.]+").findAll(path).map { it.value }.toList()
    var index = 0
    fun number(): Float = tokens.getOrNull(index)?.toFloatOrNull()?.also { index++ } ?: 0f
    fun point(px: Float, py: Float) = Offset((px + inset) * scale, (py + inset) * scale)
    while (index < tokens.size) {
        when (tokens[index++]) {
            "M" -> {
                x = number(); y = number(); startX = x; startY = y
                point(x, y).let { result.moveTo(it.x, it.y) }
            }
            "H" -> { x = number(); point(x, y).let { result.lineTo(it.x, it.y) } }
            "V" -> { y = number(); point(x, y).let { result.lineTo(it.x, it.y) } }
            "Z" -> { result.close(); x = startX; y = startY }
        }
    }
    return result
}

/** The colors of the icon: its dark tile, clay face, dark-clay marks, and gold eyes. */
object Clay {
    val ink = Color(0xFF09090A)
    val face = Color(0xFFB8703F)
    val mark = Color(0xFF3A1D0C)
    val eyes = Color(0xFFFFD27A)
}

/** Golem's face with a mood: it works (its eyes blink), waits for a person, finished its work, or failed. */
enum class Mood { Working, Waiting, Done, Failed }

private const val FACE = "M0 0H8V7H7V8H1V7H0Z"
private const val ALEPH = "M3 1H5V2H3Z"

private fun DrawScope.face(eyes: String?, mouth: String) {
    val side = size.minDimension
    drawRect(Clay.ink)
    drawPath(pixelPath(FACE, side, 10f, 1f), Clay.face)
    drawPath(pixelPath(ALEPH + mouth, side, 10f, 1f), Clay.mark)
    eyes?.let { drawPath(pixelPath(it, side, 10f, 1f), Clay.eyes) }
}

/** Golem's own face, the app icon, where Golem speaks or greets. */
@Composable
fun GolemMark(size: Dp = Tokens.Size.avatar, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size).clip(RoundedCornerShape(Tokens.Radius.sm))) {
        face("M1 2H3V3H1ZM5 2H7V3H5Z", "M2 5H6V6H2Z")
    }
}

/** Golem's face drawn from the icon's pixels, with a mood; the web's `Mark` has the same faces. */
@Composable
fun GolemFace(mood: Mood, size: Dp = Tokens.Size.avatar, modifier: Modifier = Modifier) {
    val (eyes, mouth) = when (mood) {
        Mood.Working -> "M2 2H3V3H2ZM6 2H7V3H6Z" to "M2 5H6V6H2Z"
        Mood.Waiting -> "M1 2H3V3H1ZM5 2H7V3H5Z" to "M3 4H5V6H3Z"
        Mood.Done -> "M1 2H3V3H1ZM5 2H7V3H5Z" to "M1 4H2V5H1ZM6 4H7V5H6ZM2 5H6V6H2Z"
        Mood.Failed -> "M1 2.5H3V3H1ZM5 2.5H7V3H5Z" to "M2 5H6V6H2ZM1 6H2V7H1ZM6 6H7V7H6Z"
    }
    val blinking = if (mood == Mood.Working && animate()) {
        val transition = rememberInfiniteTransition(label = "blink")
        transition.animateFloat(
            0f, 3.2f, infiniteRepeatable(tween(3200, easing = LinearEasing)), label = "blink"
        ).value > 2.94f
    } else {
        false
    }
    Canvas(modifier.size(size).clip(RoundedCornerShape(Tokens.Radius.sm))) {
        face(if (blinking) null else eyes, mouth)
    }
}

/** Golem's face as a glyph in one color: the icon's face with its marks and eyes cut out, from the same pixels. */
@Composable
fun GolemGlyph(size: Dp = 16.dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        drawPath(
            pixelPath("M0 0H8V7H7V8H1V7H0ZM3 1H5V2H3ZM2 5H6V6H2ZM1 2H3V3H1ZM5 2H7V3H5Z", this.size.minDimension,
                evenOdd = true),
            color,
        )
    }
}

/** Four pixels in a square that light in turn, clockwise: Golem works. */
@Composable
fun PixelSpinner(modifier: Modifier = Modifier) {
    val accent = Golem.colors.accent
    var lit by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    val moving = animate()
    LaunchedEffect(moving) {
        while (moving) {
            delay(250)
            lit = (lit + 1) % 4
        }
    }
    Column(modifier.semantics { contentDescription = "Working" }, verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(1.dp)) { Pixel(accent, lit == 0); Pixel(accent, lit == 1) }
        Row(horizontalArrangement = Arrangement.spacedBy(1.dp)) { Pixel(accent, lit == 3); Pixel(accent, lit == 2) }
    }
}

@Composable
private fun Pixel(color: Color, lit: Boolean) {
    Box(Modifier.size(4.dp).graphicsLayer { alpha = if (lit) 1f else 0.25f }.background(color))
}

/** A light that runs over words that Golem is at now, as on the web; a still color when motion is reduced. */
@Composable
fun shimmer(style: TextStyle): TextStyle {
    val base = Golem.mobile.textTertiary
    val light = Golem.mobile.title
    if (!animate()) return style.copy(color = Golem.mobile.text)
    val phase by rememberInfiniteTransition(label = "shimmer").animateFloat(
        0f, 1f, infiniteRepeatable(tween(2200, easing = LinearEasing), RepeatMode.Restart), label = "shimmer"
    )
    val center = (1.5f - 2 * phase) * 300f
    return style.copy(
        brush = Brush.linearGradient(
            listOf(base, light, base), start = Offset(center - 150f, 0f), end = Offset(center + 150f, 0f)
        )
    )
}

/** The current time in milliseconds, once a second, for spans that count up. */
@Composable
fun ticking(enabled: Boolean): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(enabled) {
        while (enabled) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    return now
}

/** Whether to animate: not when the person turned animations off in the system settings. */
@Composable
fun animate(): Boolean {
    val context = androidx.compose.ui.platform.LocalContext.current
    return remember(context) {
        android.provider.Settings.Global.getFloat(
            context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f
        ) != 0f
    }
}

/** The pixel icons of an agent's cards, in the gold of the icon's eyes on its dark tile. */
object PixelIcons {
    val paths = mapOf(
        "temperature" to "M3 0H5V5H6V7H5V8H3V7H2V5H3Z",
        "heat" to "M4 0H5V1H6V3H7V6H6V7H5V8H3V7H2V6H1V3H2V2H3V1H4Z",
        "rain" to "M2 1H5V2H6V3H7V5H1V4H0V3H1V2H2ZM1 6H2V7H1ZM3 6H4V8H3ZM5 6H6V7H5Z",
        "sun" to "M3 2H5V3H6V5H5V6H3V5H2V3H3ZM3 0H5V1H3ZM3 7H5V8H3ZM0 3H1V5H0ZM7 3H8V5H7Z",
        "battery" to "M0 2H7V3H8V5H7V6H0ZM1 3V5H4V3Z",
        "bolt" to "M4 0H6V1H5V3H7V4H6V5H5V6H4V7H3V8H2V5H1V4H3V2H4Z",
        "car" to "M2 1H6V2H7V4H8V6H7V7H5V6H3V7H1V6H0V4H1V2H2ZM2 2V4H6V2Z",
        "home" to "M3 0H5V1H6V2H7V3H8V4H7V8H5V5H3V8H1V4H0V3H1V2H2V1H3Z",
        "lock" to "M2 0H6V1H7V3H8V8H0V3H1V1H2ZM2 1V3H6V1ZM3 4V6H5V4Z",
    )
}

@Composable
fun PixelIcon(path: String, size: Dp = 32.dp) {
    Canvas(Modifier.size(size).clip(RoundedCornerShape(Tokens.Radius.sm)).background(Clay.ink)) {
        drawPath(pixelPath(path, this.size.minDimension, 12f, 2f, evenOdd = true), Clay.eyes)
    }
}
