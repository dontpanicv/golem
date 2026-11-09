package dev.golem.views

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.ui.NavDisplay
import dev.golem.api.Destination
import dev.golem.design.Pixel
import dev.golem.design.vector
import dev.golem.design.Golem
import dev.golem.design.GolemGlyph
import dev.golem.design.GolemMenu
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.PersonAvatar
import dev.golem.design.Tokens
import dev.golem.design.golemMono
import dev.golem.design.golemText
import dev.golem.design.mobileBackground

/** The tabs of the phone, as Slack's Android app: Home, Search, Golem, Activity, and Agenda. */
enum class Tab(val title: String) { Home("Home"), Search("Search"), Golem("Golem"), Activity("Activity"), Agenda("Agenda") }

/** The first screen of a tab, at the bottom of its back stack. */
data class TabRoot(val tab: Tab)

/** Opens a screen: Golem, Activity, Search, and Agenda in their tabs, the settings over the tabs, anything else on the open tab's stack. */
val LocalOpen = staticCompositionLocalOf<(Destination) -> Unit> { {} }

/** Whether the screen is the first of its tab, which shows the person's picture with its menu at the top left. */
val LocalTabRoot = staticCompositionLocalOf { false }

/** The page that Agenda shows, which a link to Upcoming or Following opens. */
enum class AgendaPage { Following, Upcoming }

/**
 * The phone app, as Slack's: a bottom bar of five tabs that stays under every screen and its composer, and goes under
 * the keyboard. Each tab keeps its own back stack; a tap on the open tab goes back to its first screen. Settings and
 * Workspace settings open over the tabs.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PhoneShell() {
    val session = LocalSession.current
    var tab by rememberSaveable { mutableStateOf(Tab.Home) }
    // A state, not its value: a tab's first screen keeps what it first got, so it reads the page itself.
    val agendaPage = rememberSaveable { mutableStateOf(AgendaPage.Following) }
    // One set of stacks for the shell's life: the screens keep the `open` they first got.
    val stacks = remember { Tab.entries.associateWith { mutableStateListOf<Any>(TabRoot(it)) } }
    var sheet by remember { mutableStateOf<Destination?>(null) }

    fun open(destination: Destination) {
        if (destination != Destination.Settings && destination != Destination.WorkspaceSettings) sheet = null
        when {
            destination == Destination.Chat(session.orchestrator?.id ?: "") -> {
                stacks.getValue(Tab.Golem).reset()
                tab = Tab.Golem
            }
            destination == Destination.Search -> tab = Tab.Search
            destination == Destination.Upcoming || destination == Destination.Following -> {
                stacks.getValue(Tab.Agenda).reset()
                agendaPage.value = if (destination == Destination.Upcoming) AgendaPage.Upcoming else AgendaPage.Following
                tab = Tab.Agenda
            }
            destination == Destination.Inbox -> tab = Tab.Activity
            destination == Destination.Settings || destination == Destination.WorkspaceSettings -> sheet = destination
            else -> stacks.getValue(tab).let { if (it.last() != destination) it.add(destination) }
        }
    }

    LaunchedEffect(session.workspace?.id) {
        stacks.values.forEach { it.reset() }
        session.followWorking()
    }
    LaunchedEffect(session.tapped, session.workspace?.id) { session.takeTapped()?.let(::open) }

    // Back on the first screen of another tab goes to Home, as Android's apps with a bottom bar do.
    BackHandler(enabled = tab != Tab.Home && stacks.getValue(tab).size == 1 && sheet == null) { tab = Tab.Home }

    CompositionLocalProvider(LocalOpen provides ::open) {
        Scaffold(
            containerColor = Golem.mobile.background,
            bottomBar = {
                // The keyboard covers the bar, as it covers Slack's.
                if (!WindowInsets.isImeVisible) {
                    TabBar(tab, session.inbox?.unread ?: 0) { selected ->
                        if (selected == tab) stacks.getValue(selected).reset()
                        tab = selected
                    }
                }
            },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                // Each tab keeps its stack and its place, as its saved state comes back; the open one fades in.
                val saved = rememberSaveableStateHolder()
                Crossfade(tab, animationSpec = tween(Tokens.Duration.normal), label = "tab") { shown ->
                    saved.SaveableStateProvider(shown.name) {
                        TabStack(shown, stacks.getValue(shown), agendaPage)
                    }
                }
            }
        }
        AnimatedVisibility(
            sheet != null,
            enter = slideInVertically(tween(Tokens.Duration.normal * 2)) { it } + fadeIn(),
            exit = slideOutVertically(tween(Tokens.Duration.normal * 2)) { it } + fadeOut(),
        ) {
            var shown by remember { mutableStateOf(sheet) }
            if (sheet != null) shown = sheet
            BackHandler { sheet = null }
            Box(Modifier.fillMaxSize().mobileBackground()) {
                CompositionLocalProvider(LocalClose provides { sheet = null }) {
                    when (shown) {
                        Destination.WorkspaceSettings -> WorkspaceSettingsView()
                        else -> SettingsView()
                    }
                }
            }
        }
    }
}

/** Closes the screen that opens over the tabs; null on the screens of the tabs. */
val LocalClose = staticCompositionLocalOf<(() -> Unit)?> { null }

private fun SnapshotStateList<Any>.reset() {
    while (size > 1) removeAt(lastIndex)
}

@Composable
private fun TabStack(tab: Tab, stack: SnapshotStateList<Any>, agendaPage: MutableState<AgendaPage>) {
    val session = LocalSession.current
    NavDisplay(
        backStack = stack,
        onBack = { if (stack.size > 1) stack.removeAt(stack.lastIndex) },
        entryProvider = { key ->
            NavEntry(key) {
                CompositionLocalProvider(LocalTabRoot provides (key is TabRoot)) {
                    when (key) {
                        is TabRoot -> when (key.tab) {
                            Tab.Home -> HomeView()
                            Tab.Search -> SearchView()
                            Tab.Golem -> session.orchestrator?.let { ConversationView(it.id) }
                            Tab.Activity -> InboxView()
                            Tab.Agenda -> AgendaView(agendaPage.value) { agendaPage.value = it }
                        }
                        is Destination -> Screen(key)
                    }
                }
            }
        },
    )
}

/** A screen pushed on a tab's stack. */
@Composable
private fun Screen(destination: Destination) {
    val session = LocalSession.current
    when (destination) {
        is Destination.Topic -> TopicView(destination.id)
        is Destination.NewChat -> TopicView(destination.id, compose = true)
        is Destination.Artifact -> if (destination.topic != null) {
            TopicView(destination.topic, artifactId = destination.artifact)
        } else {
            session.orchestrator?.let { ConversationView(it.id, artifactId = destination.artifact) }
        }
        is Destination.TopicDetails -> TopicDetailsView(destination.id)
        is Destination.Chat -> ConversationView(destination.id)
        Destination.Feedback -> FeedbackView()
        // These open a tab or the settings instead; see `open`.
        else -> Unit
    }
}

/** The bar, as Slack's: five tabs with their names, the open one on a filled pill, and the unread count on Activity. */
@Composable
private fun TabBar(tab: Tab, unread: Int, select: (Tab) -> Unit) {
    NavigationBar(containerColor = Golem.mobile.background, tonalElevation = 0.dp) {
        Tab.entries.forEach { item ->
            val selected = item == tab
            NavigationBarItem(
                selected = selected,
                onClick = { select(item) },
                label = { Text(item.title, style = golemText(Tokens.Mobile.FontSize.tabLabel, Tokens.FontWeight.medium)) },
                icon = {
                    BadgedBox(badge = {
                        if (item == Tab.Activity && unread > 0) {
                            Badge(containerColor = Golem.colors.accent, contentColor = Golem.colors.onAccent) {
                                Text("$unread", style = golemMono(Tokens.Mobile.FontSize.tabLabel, Tokens.FontWeight.semibold))
                            }
                        }
                    }) {
                        when (item) {
                            Tab.Golem -> Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) {
                                GolemGlyph(16.dp, if (selected) Golem.colors.accent else Golem.mobile.textSecondary)
                            }
                            else -> Icon(item.icon(), null)
                        }
                    }
                },
                modifier = Modifier.semantics {
                    contentDescription = if (item == Tab.Activity && unread > 0) "${item.title}, $unread unread" else item.title
                },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = Golem.colors.accent, selectedTextColor = Golem.mobile.title,
                    unselectedIconColor = Golem.mobile.textSecondary, unselectedTextColor = Golem.mobile.textSecondary,
                    indicatorColor = Golem.mobile.tabSelected,
                ),
            )
        }
    }
}

private fun Tab.icon() = when (this) {
    Tab.Home -> Pixel.Home.vector
    Tab.Search -> Pixel.Search.vector
    Tab.Activity -> Pixel.Bell.vector
    Tab.Agenda -> Pixel.Agenda.vector
    Tab.Golem -> Pixel.Golem.vector
}

/**
 * The top of a screen. A tab's first screen has the person's picture at the leading edge, whose menu opens both
 * settings, then the title, as Linear's Android app; a pushed screen has the back arrow and a title with an optional
 * caption, which opens the screen's menu, as Slack's channel header. A screen over the tabs has a close button.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenBar(
    title: String,
    caption: String? = null,
    menu: List<MenuAction> = emptyList(),
    leading: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val root = LocalTabRoot.current
    val close = LocalClose.current
    val back = androidx.activity.compose.LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    var menuOpen by remember { mutableStateOf(false) }
    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Golem.mobile.background, scrolledContainerColor = Golem.mobile.background),
        navigationIcon = {
            when {
                close != null -> IconButton(close) { Icon(Pixel.Close.vector, "Close", tint = Golem.mobile.title) }
                root -> YouMenu()
                else -> IconButton({ back?.onBackPressed() }) {
                    Icon(Pixel.Back.vector, "Back", tint = Golem.mobile.title)
                }
            }
        },
        title = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space.sm)) {
                leading?.invoke()
                Column(
                    Modifier.clip(RoundedCornerShape(Tokens.Radius.md))
                        .then(if (menu.isNotEmpty()) Modifier.clickable { menuOpen = true } else Modifier)
                        .semantics { heading() },
                ) {
                    val large = (root || close != null) && caption == null
                    Text(
                        title, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Golem.mobile.title,
                        style = if (large) golemText(Tokens.Mobile.FontSize.detailTitle, Tokens.FontWeight.semibold)
                        else golemText(Tokens.Mobile.FontSize.row, Tokens.FontWeight.semibold),
                    )
                    caption?.let {
                        Text(it, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Golem.mobile.textTertiary,
                            style = golemText(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.book))
                    }
                }
            }
        },
        actions = {
            actions()
            if (menu.isNotEmpty()) {
                Box {
                    IconButton({ menuOpen = true }) { Icon(Pixel.More.vector, "Menu", tint = Golem.mobile.title) }
                    GolemMenu(menuOpen, { menuOpen = false }, menu)
                }
            }
        },
    )
}

/** The person's picture, whose menu opens both settings. */
@Composable
private fun YouMenu() {
    val session = LocalSession.current
    val open = LocalOpen.current
    var expanded by remember { mutableStateOf(false) }
    Box(Modifier.padding(start = Tokens.Space.sm)) {
        Box(
            Modifier.size(48.dp).clip(RectangleShape).clickable { expanded = true }
                .semantics { contentDescription = "You" },
            contentAlignment = Alignment.Center,
        ) {
            PersonAvatar(session.user?.name ?: "", session.user?.picture, size = 32.dp)
        }
        GolemMenu(
            expanded, { expanded = false },
            listOf(
                MenuAction("Settings", Pixel.Settings.vector) { open(Destination.Settings) },
                MenuAction("Workspace settings", Pixel.Members.vector) { open(Destination.WorkspaceSettings) },
            ),
        )
    }
}
