package dev.golem.design

import android.content.res.AssetManager
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit

// The Golem design system for Android. Values come from Tokens.kt, generated from design/tokens.json, so the app
// matches the web and iOS components; Material 3 gives the native structure, in Golem's colors and type.

private val LocalColors = staticCompositionLocalOf { LightColors }
private val LocalMobileColors = staticCompositionLocalOf { LightMobileColors }
private val LocalDark = staticCompositionLocalOf { false }
private val LocalInter = staticCompositionLocalOf<FontFamily> { FontFamily.Default }

/** The colors and fonts of the open theme. */
object Golem {
    val colors: Colors
        @Composable @ReadOnlyComposable get() = LocalColors.current
    val mobile: MobileColors
        @Composable @ReadOnlyComposable get() = LocalMobileColors.current
    val dark: Boolean
        @Composable @ReadOnlyComposable get() = LocalDark.current
    val inter: FontFamily
        @Composable @ReadOnlyComposable get() = LocalInter.current
}

/** Inter at a token size and weight, as the iOS app's `Font.golem` gives it. */
@Composable
@ReadOnlyComposable
fun golemText(size: TextUnit, weight: FontWeight = Tokens.FontWeight.regular): TextStyle =
    TextStyle(fontFamily = Golem.inter, fontSize = size, fontWeight = weight)

/** Inter Variable at each weight the tokens use; the font file is the web's and the iOS app's. */
private fun inter(assets: AssetManager): FontFamily = FontFamily(
    listOf(400, 450, 500, 550, 600).map { weight ->
        Font(
            "fonts/InterVariable.ttf", assets, FontWeight(weight),
            variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
        )
    }
)

/** Golem's colors and Inter in both themes, after the system's dark or light setting. */
@Composable
fun GolemTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (dark) DarkColors else LightColors
    val mobile = if (dark) DarkMobileColors else LightMobileColors
    val assets = LocalContext.current.assets
    val family = remember(assets) { inter(assets) }
    val scheme = if (dark) {
        darkColorScheme(
            primary = colors.accent, onPrimary = colors.onAccent, secondary = colors.accent,
            background = mobile.background, onBackground = mobile.text, surface = mobile.background,
            onSurface = mobile.text, surfaceVariant = mobile.fill, onSurfaceVariant = mobile.textSecondary,
            surfaceContainer = colors.surfaceMenu, surfaceContainerHigh = colors.surfaceMenu,
            surfaceContainerHighest = mobile.fill, surfaceContainerLow = mobile.background,
            surfaceContainerLowest = mobile.background, secondaryContainer = mobile.tabSelected,
            onSecondaryContainer = mobile.title, outline = colors.borderStrong, outlineVariant = mobile.separator,
            error = mobile.danger, scrim = colors.overlay,
        )
    } else {
        lightColorScheme(
            primary = colors.accent, onPrimary = colors.onAccent, secondary = colors.accent,
            background = mobile.background, onBackground = mobile.text, surface = mobile.background,
            onSurface = mobile.text, surfaceVariant = mobile.fill, onSurfaceVariant = mobile.textSecondary,
            surfaceContainer = colors.surfaceMenu, surfaceContainerHigh = colors.surfaceMenu,
            surfaceContainerHighest = mobile.fill, surfaceContainerLow = mobile.background,
            surfaceContainerLowest = mobile.background, secondaryContainer = mobile.tabSelected,
            onSecondaryContainer = mobile.title, outline = colors.borderStrong, outlineVariant = mobile.separator,
            error = mobile.danger, scrim = colors.overlay,
        )
    }
    val base = Typography()
    val typography = Typography(
        displayLarge = base.displayLarge.copy(fontFamily = family),
        displayMedium = base.displayMedium.copy(fontFamily = family),
        displaySmall = base.displaySmall.copy(fontFamily = family),
        headlineLarge = base.headlineLarge.copy(fontFamily = family),
        headlineMedium = base.headlineMedium.copy(fontFamily = family),
        headlineSmall = base.headlineSmall.copy(fontFamily = family),
        titleLarge = base.titleLarge.copy(fontFamily = family, fontSize = Tokens.Mobile.FontSize.title,
            fontWeight = Tokens.FontWeight.semibold),
        titleMedium = base.titleMedium.copy(fontFamily = family),
        titleSmall = base.titleSmall.copy(fontFamily = family),
        bodyLarge = base.bodyLarge.copy(fontFamily = family, fontSize = Tokens.Mobile.FontSize.body),
        bodyMedium = base.bodyMedium.copy(fontFamily = family, fontSize = Tokens.Mobile.FontSize.small),
        bodySmall = base.bodySmall.copy(fontFamily = family),
        labelLarge = base.labelLarge.copy(fontFamily = family, fontSize = Tokens.Mobile.FontSize.menu,
            fontWeight = Tokens.FontWeight.book),
        labelMedium = base.labelMedium.copy(fontFamily = family, fontSize = Tokens.Mobile.FontSize.tabLabel,
            fontWeight = Tokens.FontWeight.medium),
        labelSmall = base.labelSmall.copy(fontFamily = family, fontWeight = Tokens.FontWeight.semibold),
    )
    CompositionLocalProvider(
        LocalColors provides colors,
        LocalMobileColors provides mobile,
        LocalDark provides dark,
        LocalInter provides family,
    ) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
