package dev.golem.design

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import dev.golem.api.Toast
import kotlinx.coroutines.delay

/**
 * A text field as the phone sheets have it: `fill` with radius 12 and a 1 dp accent outline while focused, the
 * placeholder in `placeholder`. `large` is the 40 dp field of sign-in and search; an optional label sits above.
 */
@Composable
fun GolemTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    label: String? = null,
    large: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    autofocus: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val focus = remember { FocusRequester() }
    val shape = RoundedCornerShape(Tokens.Radius.xl)
    LaunchedEffect(autofocus) { if (autofocus) focus.requestFocus() }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Tokens.Space.xs)) {
        label?.let {
            Text(it, style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium), color = Golem.mobile.textSecondary)
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = singleLine,
            minLines = minLines,
            interactionSource = interaction,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            textStyle = golemText(if (large) Tokens.Mobile.FontSize.body else Tokens.Mobile.FontSize.row).copy(color = Golem.mobile.text),
            cursorBrush = SolidColor(Golem.colors.accent),
            modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = label ?: placeholder },
            decorationBox = { field ->
                Box(
                    Modifier.fillMaxWidth().heightIn(min = if (large) 48.dp else Tokens.Size.listRow)
                        .background(Golem.mobile.fill, shape)
                        .border(1.dp, if (focused) Golem.colors.accent else Color.Transparent, shape)
                        .padding(horizontal = Tokens.Space.lg, vertical = Tokens.Space.md),
                    contentAlignment = if (singleLine) Alignment.CenterStart else Alignment.TopStart,
                ) {
                    if (value.isEmpty()) {
                        Text(placeholder, style = golemText(if (large) Tokens.Mobile.FontSize.body else Tokens.Mobile.FontSize.row),
                            color = Golem.mobile.placeholder)
                    }
                    field()
                }
            },
        )
    }
}

/** A switch in the accent, Material's own, as Linear's Android app has it. */
@Composable
fun GolemSwitch(checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true, label: String? = null) {
    Switch(
        checked = checked, onCheckedChange = onChange, enabled = enabled,
        modifier = if (label != null) Modifier.semantics { contentDescription = label } else Modifier,
        colors = SwitchDefaults.colors(
            checkedTrackColor = Golem.colors.accent, checkedThumbColor = Golem.colors.onAccent,
            uncheckedTrackColor = Golem.colors.switchTrack, uncheckedThumbColor = Golem.colors.onAccent,
            uncheckedBorderColor = Color.Transparent, checkedBorderColor = Color.Transparent,
        ),
    )
}

/** One item of a menu: an icon, its label, and a check when it is the current one. */
data class MenuAction(
    val label: String,
    val icon: ImageVector? = null,
    val checked: Boolean = false,
    val danger: Boolean = false,
    /** Opens a submenu of these instead of acting. */
    val children: List<MenuAction>? = null,
    val action: () -> Unit = {},
)

/** A native Material menu in Golem's colors; an item with children opens them in its place. */
@Composable
fun GolemMenu(expanded: Boolean, onDismiss: () -> Unit, items: List<MenuAction>, offset: DpOffset = DpOffset(0.dp, 0.dp)) {
    var submenu by remember(expanded) { mutableStateOf<MenuAction?>(null) }
    DropdownMenu(
        expanded = expanded, onDismissRequest = onDismiss, offset = offset,
        containerColor = Golem.colors.surfaceMenu, shape = RoundedCornerShape(Tokens.Radius.xl),
    ) {
        val shown = submenu?.children ?: items
        submenu?.let {
            Text(
                it.label, style = golemText(Tokens.FontSize.sm, Tokens.FontWeight.medium), color = Golem.colors.textTertiary,
                modifier = Modifier.padding(horizontal = Tokens.Space.lg, vertical = Tokens.Space.sm),
            )
        }
        shown.forEach { item ->
            val color = if (item.danger) Golem.colors.danger else Golem.mobile.text
            DropdownMenuItem(
                text = { Text(item.label, style = golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book), maxLines = 1,
                    overflow = TextOverflow.Ellipsis) },
                onClick = {
                    if (item.children != null) {
                        submenu = item
                    } else {
                        onDismiss()
                        item.action()
                    }
                },
                leadingIcon = item.icon?.let { { Icon(it, null, Modifier.size(20.dp)) } },
                trailingIcon = if (item.checked) ({ Icon(Icons.Outlined.CheckCircle, "Current", Modifier.size(18.dp)) }) else null,
                colors = MenuDefaults.itemColors(textColor = color, leadingIconColor = color, trailingIconColor = Golem.colors.accent),
            )
        }
    }
}

/**
 * A dialog: the title, stacked fields, and right-aligned actions, secondary then primary. It closes on the backdrop
 * and on Back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GolemDialog(
    title: String,
    onDismiss: () -> Unit,
    actions: @Composable () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    BasicAlertDialog(onDismissRequest = onDismiss) {
        val shape = RoundedCornerShape(Tokens.Radius.xl + 8.dp)
        Column(
            Modifier.widthIn(max = Tokens.Size.dialog).fillMaxWidth()
                .golemShadow(Tokens.Shadows.modal, shape)
                .background(Golem.mobile.background, shape)
                .border(0.5.dp, Golem.colors.borderDialog, shape)
                .padding(Tokens.Space.xxl),
            verticalArrangement = Arrangement.spacedBy(Tokens.Space.lg),
        ) {
            Text(
                title, style = golemText(Tokens.Mobile.FontSize.sheetTitle, Tokens.FontWeight.semibold), color = Golem.mobile.title,
                modifier = Modifier.semantics { heading() },
            )
            content()
            Row(
                Modifier.fillMaxWidth().padding(top = Tokens.Space.md),
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md, Alignment.End),
            ) { actions() }
        }
    }
}

/** The toast over the bottom of the screen: the last failure of an action, or a confirmation; it goes after 4 s. */
@Composable
fun BoxScope.Toasts() {
    val session = LocalSession.current
    val toast = session.toast
    var shown by remember { mutableStateOf<Toast?>(null) }
    LaunchedEffect(toast) {
        if (toast == null) return@LaunchedEffect
        shown = toast
        delay(4000)
        if (session.toast == toast) session.toast = null
    }
    AnimatedVisibility(
        toast != null,
        modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding()
            .padding(bottom = Tokens.Mobile.Size.tabBar + Tokens.Space.lg, start = Tokens.Space.lg, end = Tokens.Space.lg),
        enter = slideInVertically(tween(Tokens.Duration.toast)) { it } + fadeIn(tween(Tokens.Duration.toast)),
        exit = slideOutVertically(tween(Tokens.Duration.toast)) { it } + fadeOut(tween(Tokens.Duration.toast)),
    ) {
        val current = shown ?: return@AnimatedVisibility
        val shape = RoundedCornerShape(Tokens.Radius.xl)
        val (icon, tint) = when (current.tone) {
            Toast.Tone.Neutral -> Icons.Outlined.Info to Golem.colors.textSecondary
            Toast.Tone.Success -> Icons.Outlined.CheckCircle to Golem.colors.success
            Toast.Tone.Error -> Icons.Outlined.ErrorOutline to Golem.colors.danger
        }
        Row(
            Modifier.widthIn(max = Tokens.Size.toast).fillMaxWidth()
                .golemShadow(Tokens.Shadows.menu, shape)
                .background(Golem.colors.surfaceMenu, shape)
                .border(0.5.dp, Golem.colors.ringControl, shape)
                .clickable { session.toast = null }
                .padding(Tokens.Space.lg),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space.md),
        ) {
            Icon(icon, null, Modifier.size(16.dp), tint = tint)
            Text(current.message, style = golemText(Tokens.FontSize.md, Tokens.FontWeight.medium), color = Golem.colors.text,
                modifier = Modifier.weight(1f))
            Icon(Icons.Outlined.Close, "Close", Modifier.size(12.dp), tint = Golem.colors.textTertiary)
        }
    }
}

/** A full-screen layer, as a screen that a menu opens over the tabs. */
@Composable
fun FullScreen(content: @Composable BoxScope.() -> Unit) {
    Box(Modifier.fillMaxSize().mobileBackground(), content = content)
}
