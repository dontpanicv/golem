package dev.golem.design

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import dev.golem.api.Session

/** The session of the app, which every screen reads the server through. */
val LocalSession = staticCompositionLocalOf<Session> { error("No session") }

// Surfaces

/** The layers of a token shadow, in the open theme. */
@Composable
fun Modifier.golemShadow(shadow: ThemedShadow, shape: Shape): Modifier {
    val layers = if (Golem.dark) shadow.dark else shadow.light
    return layers.fold(this) { modifier, layer ->
        modifier.dropShadow(
            shape,
            Shadow(radius = layer.blur, color = Color.Black.copy(alpha = layer.alpha), spread = layer.spread,
                offset = DpOffset(0.dp, layer.y)),
        )
    }
}

/** A raised card: `surfaceRaised` with a 0.5 dp `ring` and the `low` shadow. */
@Composable
fun Modifier.raisedCard(radius: Dp = Tokens.Radius.lg, fill: Color? = null, ring: Color? = null): Modifier {
    val shape = RoundedCornerShape(radius)
    return golemShadow(Tokens.Shadows.low, shape)
        .background(fill ?: Golem.colors.surfaceRaised, shape)
        .border(0.5.dp, ring ?: Golem.colors.ring, shape)
}

// People

/** A person's picture, or their initial on a color picked by the sum of their name's code points, as the web does. */
@Composable
fun PersonAvatar(name: String, picture: String?, size: Dp = Tokens.Size.avatar, modifier: Modifier = Modifier) {
    val session = LocalSession.current
    val url = picture?.let { session.api.profilePictureUrl(it) }
    Box(modifier.size(size).clip(CircleShape), contentAlignment = Alignment.Center) {
        Initial(name, size)
        if (url != null) {
            AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun Initial(name: String, size: Dp) {
    val sum = name.codePoints().toArray().sum()
    val color = Tokens.avatarColors[sum % Tokens.avatarColors.size]
    Box(Modifier.fillMaxSize().background(color), contentAlignment = Alignment.Center) {
        Text(
            name.take(1).uppercase(),
            style = golemText(with(androidx.compose.ui.platform.LocalDensity.current) { (size * 0.45f).toSp() },
                Tokens.FontWeight.medium),
            color = Golem.colors.onAccent,
        )
    }
}

// Lists

/**
 * A list row: an icon, a title, an optional subtitle, and trailing content. Rows sit 10 dp in from the screen edge
 * with their content 10 dp further in, as Linear's; a row lights up under a finger.
 */
@Composable
fun ListRow(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    subtitle: String? = null,
    working: Boolean = false,
    emoji: String? = null,
    golem: Boolean = false,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 1.5.dp)
            .clip(RoundedCornerShape(Tokens.Radius.xl))
            .then(if (onClick != null) Modifier.pressable(onClick, onLongClick) else Modifier)
            .heightIn(min = Tokens.Mobile.Size.row - 3.dp)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md),
    ) {
        Box(Modifier.width(21.dp), contentAlignment = Alignment.Center) {
            when {
                golem -> GolemGlyph(16.dp, Golem.mobile.textSecondary)
                emoji != null -> Text(emoji, style = golemText(Tokens.FontSize.lg))
                icon != null -> Icon(icon, null, Modifier.size(18.dp), tint = Golem.mobile.textSecondary)
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md)) {
                Text(
                    title, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book),
                    color = Golem.mobile.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (working) PixelSpinner()
            }
            if (subtitle != null) {
                Text(
                    subtitle, style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book),
                    color = Golem.mobile.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        trailing()
    }
}

/** A tap, and a long press when given, with the row's light under the finger. */
fun Modifier.pressable(onClick: () -> Unit, onLongClick: (() -> Unit)? = null): Modifier =
    if (onLongClick == null) clickable(role = Role.Button, onClick = onClick)
    else combinedClickable(onClick = onClick, onLongClick = onLongClick, role = Role.Button)

/** The full-width hairline between groups of rows. */
@Composable
fun ListSeparator() {
    Box(Modifier.padding(vertical = Tokens.Space.sm).fillMaxWidth().height(1.dp).background(Golem.mobile.separator))
}

/** The heading of a list section, as Linear's "In Progress": small and dim, with an optional action at the end. */
@Composable
fun ListSectionHeader(title: String, action: (@Composable () -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Mobile.Size.margin).heightIn(min = Tokens.Size.listRow),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title, style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book),
            color = Golem.mobile.textQuaternary, modifier = Modifier.weight(1f).semantics { heading() },
        )
        action?.invoke()
    }
}

/** A heading inside a list section, smaller and dimmer than the section's. */
@Composable
fun ListSubheading(title: String) {
    Text(
        title, style = golemText(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.medium),
        color = Golem.mobile.textTertiary,
        modifier = Modifier.padding(horizontal = Tokens.Mobile.Size.margin).padding(top = Tokens.Space.md)
            .semantics { heading() },
    )
}

/** A list section whose heading folds it, as Slack's Home sections: the chevron turns and the rows slide away. */
@Composable
fun FoldingSection(title: String, folded: Boolean, onFold: (Boolean) -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val turn by animateFloatAsState(if (folded) -90f else 0f, label = "chevron")
    Column {
        Row(
            Modifier.fillMaxWidth().clickable { onFold(!folded) }.heightIn(min = Tokens.Size.listRow)
                .padding(horizontal = Tokens.Mobile.Size.margin).semantics { heading() },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                title, style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium),
                color = Golem.mobile.textSecondary, modifier = Modifier.weight(1f),
            )
            Icon(Icons.Outlined.ExpandMore, if (folded) "Folded" else "Open", Modifier.size(18.dp).rotate(turn),
                tint = Golem.mobile.textQuaternary)
        }
        AnimatedVisibility(!folded, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Column(content = content)
        }
    }
}

/** The title of a pushed screen at the top of its content, as Linear's issue title, with an optional caption above. */
@Composable
fun DetailTitle(title: String, caption: String? = null, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
        caption?.let {
            Text(it, style = golemText(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.book), color = Golem.mobile.textTertiary)
        }
        Text(
            title, style = golemText(Tokens.Mobile.FontSize.detailTitle, Tokens.FontWeight.semibold),
            color = Golem.mobile.text, modifier = Modifier.semantics { heading() },
        )
    }
}

/** Golem at work, as Slack's typing line: four pixels that light in turn, then the words. */
@Composable
fun WorkingLabel(text: String = "Golem is working") {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm)) {
        PixelSpinner()
        Text(text, style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book), color = Golem.mobile.textSecondary)
    }
}

@Composable
fun EmptyState(title: String, icon: @Composable () -> Unit = {}, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(Tokens.Space.xxxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Space.sm, Alignment.CenterVertically),
    ) {
        icon()
        Text(title, style = golemText(Tokens.FontSize.md, Tokens.FontWeight.medium), color = Golem.colors.textSecondary)
    }
}

/** A status: a dot and text. */
enum class Tone { Neutral, Accent, Success, Warning, Danger }

@Composable
fun Badge(label: String, tone: Tone = Tone.Neutral) {
    val color = when (tone) {
        Tone.Neutral -> Golem.colors.textQuaternary
        Tone.Accent -> Golem.colors.accent
        Tone.Success -> Golem.colors.success
        Tone.Warning -> Golem.colors.warning
        Tone.Danger -> Golem.colors.danger
    }
    Row(
        Modifier.heightIn(min = Tokens.Size.controlTiny), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm),
    ) {
        Box(Modifier.size(Tokens.Size.dot).background(color, CircleShape))
        Text(label, style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book), color = Golem.mobile.textSecondary)
    }
}

// Files

/** A file attached to a message, or picked in the composer; picked files have a button that takes them out. */
@Composable
fun FileChip(name: String, onClick: (() -> Unit)? = null, remove: (() -> Unit)? = null) {
    val shape = RoundedCornerShape(Tokens.Radius.md)
    Box(Modifier.heightIn(min = Tokens.Size.listRow), contentAlignment = Alignment.Center) {
        Row(
            Modifier.widthIn(max = 240.dp).heightIn(min = Tokens.Size.controlSmall).clip(shape)
                .background(Golem.colors.fillSubtle).border(0.5.dp, Golem.colors.ring, shape)
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .padding(start = Tokens.Space.md, end = if (remove == null) 10.dp else 0.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space.xs),
        ) {
            Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, Modifier.size(14.dp), tint = Golem.colors.textTertiary)
            Text(
                name, style = golemText(Tokens.FontSize.sm), color = Golem.colors.textSecondary, maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f, fill = false),
            )
            if (remove != null) {
                Box(Modifier.size(Tokens.Size.controlSmall).clickable(onClick = remove), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.Close, "Remove $name", Modifier.size(14.dp), tint = Golem.colors.textTertiary)
                }
            }
        }
    }
}

/** File chips in a row that scrolls sideways. */
@Composable
fun FileChips(names: List<String>, open: ((Int) -> Unit)? = null, remove: ((Int) -> Unit)? = null, modifier: Modifier = Modifier) {
    Row(modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
        names.forEachIndexed { index, name ->
            FileChip(name, open?.let { { it(index) } }, remove?.let { { it(index) } })
        }
    }
}

// Buttons

enum class ButtonVariant { Primary, Secondary, Ghost, Danger }
enum class ButtonSize { Regular, Small, Large }

/**
 * A button per design/components.md: four variants, all pills. The visual height follows the spec; the touch target
 * reaches 48 dp, as Android asks.
 */
@Composable
fun GolemButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: ButtonVariant = ButtonVariant.Secondary,
    size: ButtonSize = ButtonSize.Regular,
    enabled: Boolean = true,
    busy: Boolean = false,
    icon: ImageVector? = null,
) {
    val height = when (size) {
        ButtonSize.Regular -> Tokens.Size.control
        ButtonSize.Small -> Tokens.Size.controlSmall
        ButtonSize.Large -> Tokens.Size.controlLarge
    }
    val shape = RoundedCornerShape(50)
    val colors = Golem.colors
    val (fill, text) = when (variant) {
        ButtonVariant.Primary -> colors.accent to colors.onAccent
        ButtonVariant.Secondary -> Golem.mobile.fill to Golem.mobile.text
        ButtonVariant.Ghost -> Color.Transparent to colors.textTertiary
        ButtonVariant.Danger -> Color.Transparent to colors.danger
    }
    Box(
        modifier.heightIn(min = 48.dp).then(if (size == ButtonSize.Large) Modifier.fillMaxWidth() else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .then(if (size == ButtonSize.Large) Modifier.fillMaxWidth() else Modifier)
                .height(height)
                .then(if (variant == ButtonVariant.Primary) Modifier.golemShadow(Tokens.Shadows.low, shape) else Modifier)
                .clip(shape)
                .background(fill)
                .clickable(enabled = enabled && !busy, role = Role.Button, onClick = onClick)
                .graphicsLayer { alpha = if (enabled) 1f else 0.6f }
                .padding(horizontal = if (size == ButtonSize.Small) 10.dp else Tokens.Space.lg),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm, Alignment.CenterHorizontally),
        ) {
            if (busy) {
                CircularProgressIndicator(Modifier.size(14.dp), color = text, strokeWidth = 1.5.dp)
            } else if (icon != null) {
                Icon(icon, null, Modifier.size(14.dp), tint = text)
            }
            Text(
                label, maxLines = 1, color = text,
                style = golemText(if (size == ButtonSize.Small) Tokens.FontSize.sm else Tokens.FontSize.md, Tokens.FontWeight.medium),
            )
        }
    }
}

/** A round button of an icon, such as the composer's send button: `tint` while enabled, else the gray fill. */
@Composable
fun CircleButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = Golem.colors.accent,
    size: Dp = Tokens.Mobile.Size.send,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    Box(
        modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled && !busy, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(size).background(if (enabled) tint else Golem.mobile.fill, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (busy) {
                CircularProgressIndicator(Modifier.size(14.dp), color = Golem.colors.onAccent, strokeWidth = 1.5.dp)
            } else {
                Icon(icon, label, Modifier.size(Tokens.Size.icon),
                    tint = if (enabled) Golem.colors.onAccent else Golem.mobile.textQuaternary)
            }
        }
    }
}

/**
 * Pills that switch the view of a screen, as Linear's Assigned, Created, and Subscribed: the selected one sits on the
 * `fill`, the others are plain text. An optional count follows each title.
 */
@Composable
fun <T> PillBar(selection: T, options: List<T>, title: (T) -> String, onSelect: (T) -> Unit, count: ((T) -> Int?)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Space.lg),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        options.forEach { option ->
            val selected = option == selection
            Row(
                Modifier.height(Tokens.Mobile.Size.pill).clip(RoundedCornerShape(50))
                    .background(if (selected) Golem.mobile.fill else Color.Transparent)
                    .clickable(role = Role.Tab) { onSelect(option) }
                    .padding(horizontal = Tokens.Space.lg),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md),
            ) {
                val style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book)
                Text(title(option), style = style, color = if (selected) Golem.mobile.text else Golem.mobile.textSecondary)
                count?.invoke(option)?.let { Text("$it", style = style, color = Golem.mobile.textQuaternary) }
            }
        }
    }
}

// Settings

/** A settings row: label and description on the left, the control on the right, 20 dp in from the edges. */
@Composable
fun SettingsRow(
    label: String,
    modifier: Modifier = Modifier,
    description: String? = null,
    descriptionColor: Color? = null,
    labelColor: Color? = null,
    onClick: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    control: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier.fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .heightIn(min = Tokens.Mobile.Size.settingsRow)
            .padding(horizontal = Tokens.Mobile.Size.margin, vertical = Tokens.Space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space.lg),
    ) {
        leading?.invoke()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book), color = labelColor ?: Golem.mobile.text)
            description?.let {
                Text(it, style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book),
                    color = descriptionColor ?: Golem.mobile.textTertiary)
            }
        }
        control()
    }
}

/** The page background of a phone screen. */
@Composable
fun Modifier.mobileBackground(): Modifier = background(Golem.mobile.background)

/** Content inside a box, centered, such as a spinner while a screen loads. */
@Composable
fun Centered(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center, content = content)
}

@Composable
fun Loading() {
    Centered { CircularProgressIndicator(Modifier.size(24.dp), color = Golem.colors.accent, strokeWidth = 2.dp) }
}

val ListPadding = PaddingValues(bottom = Tokens.Space.xxxl)

@Composable
fun Gap(height: Dp) = Spacer(Modifier.height(height))
