package dev.golem.views

import android.Manifest
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dev.golem.GolemApp
import dev.golem.design.ButtonSize
import dev.golem.design.ButtonVariant
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemMark
import dev.golem.design.GolemTextField
import dev.golem.design.LocalSession
import dev.golem.design.Loading
import dev.golem.design.Toasts
import dev.golem.design.Tokens
import dev.golem.design.golemText
import dev.golem.design.mobileBackground
import dev.golem.phone.PhoneLink
import dev.golem.places.PlacePermission
import kotlinx.coroutines.launch

/** Sign-in, then the open workspace. Every screen reads the server through the session. */
@Composable
fun RootView(openSignIn: (Uri, String, String) -> Unit) {
    val session = (LocalContext.current.applicationContext as GolemApp).session
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    CompositionLocalProvider(LocalSession provides session) {
        Box(Modifier.fillMaxSize().mobileBackground()) {
            when {
                !session.signedIn -> LoginView(openSignIn)
                session.user == null -> LoadingView()
                session.workspaces.isEmpty() -> NotMemberView()
                else -> PhoneShell()
            }
            Toasts()
        }
        LaunchedEffect(session.signedIn) { if (session.signedIn) session.load() }
        // Threads read on screen read their notifications, so the inbox loads again when the app comes back.
        LaunchedEffect(session.signedIn) {
            if (!session.signedIn) return@LaunchedEffect
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { runCatching { session.loadInbox() } }
        }
        NotificationPermission()
        PlacePermission()
        // The agents use the phone's tools while the app is on screen. A reminder or a routine at a place that an agent
        // made while the app was open is watched once the app goes to the background.
        val activity = LocalActivity.current as? ComponentActivity
        DisposableEffect(session.signedIn, activity) {
            if (!session.signedIn || activity == null) return@DisposableEffect onDispose {}
            val link = PhoneLink(activity, session.api)
            val observer = LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_START) link.start()
                if (event == Lifecycle.Event.ON_STOP) {
                    link.stop()
                    session.scope.launch { session.watchPlaces() }
                }
            }
            lifecycle.addObserver(observer)
            onDispose {
                lifecycle.removeObserver(observer)
                link.close()
            }
        }
    }
}

/** Asks once for notifications, which the app shows while it runs. */
@Composable
private fun NotificationPermission() {
    val session = LocalSession.current
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(session.user != null) { if (session.user != null) ask.launch(Manifest.permission.POST_NOTIFICATIONS) }
}

@Composable
private fun LoginView(openSignIn: (Uri, String, String) -> Unit) {
    val session = LocalSession.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    fun submit() {
        if (busy || session.serverUrl.isBlank()) return
        busy = true
        scope.launch {
            session.run { session.signIn(openSignIn) }
            busy = false
        }
    }
    CenteredForm("Sign in to Golem") {
        GolemTextField(
            value = session.serverUrl, onValueChange = session::setServer, placeholder = "Server",
            large = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Uri, capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
                imeAction = ImeAction.Go,
            ),
            keyboardActions = KeyboardActions(onGo = { submit() }),
        )
        GolemButton(
            "Continue with Google", ::submit, variant = ButtonVariant.Primary, size = ButtonSize.Large,
            enabled = session.serverUrl.isNotBlank(), busy = busy, modifier = Modifier.padding(top = Tokens.Space.xs),
        )
    }
}

/** Shown to a person who signed in before a family member added them. */
@Composable
private fun NotMemberView() {
    val session = LocalSession.current
    CenteredForm("Ask a family member to add you") {
        GolemButton("Try again", { session.launch { session.load() } }, variant = ButtonVariant.Primary,
            size = ButtonSize.Large)
        GolemButton("Sign out", { session.launch { session.signOut() } }, variant = ButtonVariant.Ghost)
    }
}

@Composable
private fun LoadingView() {
    val session = LocalSession.current
    val error = session.loadError
    if (error == null) return Loading()
    Column(
        Modifier.fillMaxSize().padding(Tokens.Space.xxl), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Space.lg, Alignment.CenterVertically),
    ) {
        Icon(Icons.Outlined.WifiOff, null, tint = Golem.colors.textQuaternary)
        Text(error, style = golemText(Tokens.FontSize.md, Tokens.FontWeight.medium), color = Golem.colors.textSecondary,
            textAlign = TextAlign.Center)
        GolemButton("Retry", { session.launch { session.load() } }, variant = ButtonVariant.Primary)
        GolemButton("Sign out", { session.launch { session.signOut() } }, variant = ButtonVariant.Ghost)
    }
}

/** The sign-in layout, after Linear's: a centered mark and title, large fields, and a link below. */
@Composable
private fun CenteredForm(title: String, content: @Composable () -> Unit) {
    Box(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.widthIn(max = 360.dp).fillMaxWidth().padding(Tokens.Space.xxl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Tokens.Space.lg),
        ) {
            GolemMark(48.dp)
            Text(
                title, style = golemText(Tokens.FontSize.xl, Tokens.FontWeight.medium), color = Golem.colors.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = Tokens.Space.md, bottom = Tokens.Space.lg).semantics { heading() },
            )
            content()
        }
    }
}
