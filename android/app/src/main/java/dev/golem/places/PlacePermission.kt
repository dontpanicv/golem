package dev.golem.places

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import dev.golem.design.ButtonVariant
import dev.golem.design.Golem
import dev.golem.design.GolemButton
import dev.golem.design.GolemDialog
import dev.golem.design.LocalSession
import dev.golem.design.Tokens
import dev.golem.design.golemText
import kotlinx.coroutines.launch

/**
 * Asks for the location all the time while reminders or routines wait at a place, once each time the app starts:
 * Android gives the precise location first, then all the time in its settings.
 */
@Composable
fun PlacePermission() {
    val session = LocalSession.current
    val context = LocalContext.current
    var answered by rememberSaveable { mutableStateOf(false) }
    val always = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        session.scope.launch { session.watchPlaces() }
    }
    val precise = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result[Manifest.permission.ACCESS_FINE_LOCATION] == true) always.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    }
    if (!PlaceWatcher.needsPermission || answered) return
    GolemDialog(
        "Reminders at places",
        onDismiss = { answered = true },
        actions = {
            GolemButton("Not now", { answered = true }, variant = ButtonVariant.Ghost)
            GolemButton("Allow", {
                answered = true
                if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    always.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                } else {
                    precise.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                }
            }, variant = ButtonVariant.Primary)
        },
    ) {
        Text(
            "Golem needs your location all the time to remind you when you arrive or leave. Only the arrival or the " +
                "departure goes to Golem, never where you are.",
            style = golemText(Tokens.Mobile.FontSize.row), color = Golem.mobile.textSecondary,
        )
    }
}
