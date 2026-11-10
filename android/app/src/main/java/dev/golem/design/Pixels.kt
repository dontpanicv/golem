package dev.golem.design

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.golem.R
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

/** The colors of Golem's face: a white face and black marks. The eyes take the accent. */
object Ember {
    val ink = Color(0xFF000000)
    val face = Color(0xFFFFFFFF)
}

/** An icon of the 16 × 16 pixel set: 1 dp a pixel, for Material's `Icon`. */
val Pixel.vector: ImageVector
    get() = vectors.getOrPut(this) {
        ImageVector.Builder(name, 16.dp, 16.dp, 16f, 16f)
            .addPath(addPathNodes(path), fill = SolidColor(Color.Black))
            .build()
    }

private val vectors = mutableMapOf<Pixel, ImageVector>()

/** Golem's logo, one noise cell a dp, at a side of `golemLogos`. The web's `Mark`. In light, a black tile keeps the white face apart from the white surface. */
@Composable
fun GolemMark(size: Dp = Tokens.Size.avatar, modifier: Modifier = Modifier) {
    val (face, forehead) = golemLogos.getValue(size.value.toInt())
    val cells = size.value
    val tile = if (Golem.colors === DarkColors) Color.Transparent else Ember.ink
    val accent = Golem.colors.accent
    Canvas(modifier.size(size)) {
        val side = this.size.minDimension
        drawRect(tile)
        drawPath(pixelPath(face, side, cells), Ember.face)
        drawPath(pixelPath(forehead, side, cells), accent)
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
        Row(horizontalArrangement = Arrangement.spacedBy(1.dp)) { SpinnerCell(accent, lit == 0); SpinnerCell(accent, lit == 1) }
        Row(horizontalArrangement = Arrangement.spacedBy(1.dp)) { SpinnerCell(accent, lit == 3); SpinnerCell(accent, lit == 2) }
    }
}

@Composable
private fun SpinnerCell(color: Color, lit: Boolean) {
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

/** The pixel icons of an agent's cards, in the accent on a black tile. */
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
    val accent = Golem.colors.accent
    Canvas(Modifier.size(size).background(Ember.ink)) {
        drawPath(pixelPath(path, this.size.minDimension, 12f, 2f, evenOdd = true), accent)
    }
}
