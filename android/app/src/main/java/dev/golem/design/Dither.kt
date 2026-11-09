package dev.golem.design

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ImageShader
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.util.Calendar
import kotlin.math.ceil
import kotlin.math.pow
import kotlin.math.roundToInt

private val RANKS = arrayOf(
    intArrayOf(0, 32, 8, 40, 2, 34, 10, 42),
    intArrayOf(48, 16, 56, 24, 50, 18, 58, 26),
    intArrayOf(12, 44, 4, 36, 14, 46, 6, 38),
    intArrayOf(60, 28, 52, 20, 62, 30, 54, 22),
    intArrayOf(3, 35, 11, 43, 1, 33, 9, 41),
    intArrayOf(51, 19, 59, 27, 49, 17, 57, 25),
    intArrayOf(15, 47, 7, 39, 13, 45, 5, 37),
    intArrayOf(63, 31, 55, 23, 61, 29, 53, 21),
)

private val FACE = listOf("########", "###..###", "#..##..#", "########", "########", "##....##", "########", ".######.")

/** A dither pattern: a size in cells, and how lit it is at a place from 0 to 1. Android's `Dither` of the web and iOS. */
data class DitherPattern(val width: Int, val height: Int, val value: (Double, Double) -> Double)

object Dither {
    val FadeTop = DitherPattern(8, 28) { _, v -> 1 - v }
    val FadeBottom = DitherPattern(8, 56) { _, v -> v }
    val EmptyFace = DitherPattern(96, 96) { u, v -> if (FACE[(v * 8).toInt()][(u * 8).toInt()] == '#') 0.1 + 0.75 * (1 - v) else 0.0 }

    private val corners = mutableMapOf<Int, DitherPattern>()

    /** Kept, so that each tile size is one pattern and `remember` finds it. */
    fun corner(side: Int): DitherPattern = corners.getOrPut(side) {
        DitherPattern(side, side) { u, v -> ((u + v) / 2 - 0.48) * 2 }
    }
}

/** A bitmap at the device's scale: each cell's edges on whole pixels, so a cell stays 1 dp and crisp at any density. */
private fun DitherPattern.bitmap(density: Float): ImageBitmap {
    val widthPixels = ceil(width * density).toInt()
    val heightPixels = ceil(height * density).toInt()
    val pixels = IntArray(widthPixels * heightPixels)
    for (y in 0 until height) {
        for (x in 0 until width) {
            val on = value((x + 0.5) / width, (y + 0.5) / height) > (RANKS[y % 8][x % 8] + 0.5) / 64
            if (!on) continue
            val left = (x * density).roundToInt()
            val right = ((x + 1) * density).roundToInt().coerceAtMost(widthPixels)
            val top = (y * density).roundToInt()
            val bottom = ((y + 1) * density).roundToInt().coerceAtMost(heightPixels)
            for (row in top until bottom) pixels.fill(0xFFFFFFFF.toInt(), row * widthPixels + left, row * widthPixels + right)
        }
    }
    return Bitmap.createBitmap(pixels, widthPixels, heightPixels, Bitmap.Config.ARGB_8888).asImageBitmap()
}

/** A dither pattern in `color`, repeated to fill its frame. */
@Composable
fun DitherView(pattern: DitherPattern, color: Color, modifier: Modifier = Modifier) {
    val density = LocalDensity.current.density
    val image = remember(pattern, density) { pattern.bitmap(density) }
    val brush = remember(image) { ShaderBrush(ImageShader(image, TileMode.Repeated, TileMode.Repeated)) }
    Canvas(modifier) { drawRect(brush, colorFilter = ColorFilter.tint(color)) }
}

/** A dotted line of pixels: under a header and between groups. */
@Composable
fun DottedLine(color: Color = Golem.colors.textQuaternary, modifier: Modifier = Modifier) {
    Canvas(modifier.fillMaxWidth().height(1.dp)) {
        val dot = 1.dp.toPx()
        drawLine(
            color, Offset(0f, dot / 2), Offset(size.width, dot / 2), strokeWidth = dot,
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(dot, dot * 3)),
        )
    }
}

/** A day of 24 cells: the hours gone, and the hour of `at` in the accent. */
@Composable
fun DayStrip(at: Double) {
    val hour = remember(at) { Calendar.getInstance().apply { timeInMillis = at.toLong() }.get(Calendar.HOUR_OF_DAY) }
    val colors = Golem.colors
    Row(horizontalArrangement = Arrangement.spacedBy(1.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(24) { index ->
            Box(
                Modifier.width(2.dp).height(if (index == hour) 12.dp else 8.dp).background(
                    when {
                        index == hour -> colors.accent
                        index < hour -> colors.textQuaternary
                        else -> colors.border
                    }
                )
            )
        }
    }
}
