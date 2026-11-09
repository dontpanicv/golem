package dev.golem

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import dev.golem.api.ApiException
import dev.golem.api.Destination
import dev.golem.api.Tapped
import dev.golem.design.GolemTheme
import dev.golem.views.RootView

class MainActivity : ComponentActivity() {
    private val session get() = (application as GolemApp).session

    /** Google sign-in in an Auth Tab, which returns only to the server's https address (`Session.signIn`). */
    private val signIn = AuthTabIntent.registerActivityResultLauncher(this) { result ->
        session.signInReturned(if (result.resultCode == AuthTabIntent.RESULT_OK) result.resultUri else null)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        take(intent)
        setContent {
            GolemTheme {
                RootView(openSignIn = ::openSignIn)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        take(intent)
    }

    /** Opens the address in an Auth Tab that waits for `host` and `path`; a browser without Auth Tabs cannot. */
    private fun openSignIn(url: Uri, host: String, path: String) {
        val browser = CustomTabsClient.getPackageName(this, null)
        if (browser == null || !CustomTabsClient.isAuthTabSupported(this, browser)) {
            session.signInReturned(null)
            throw ApiException(0, "Sign-in needs Chrome or another browser with Auth Tabs.")
        }
        AuthTabIntent.Builder().build().launch(signIn, url, host, path)
    }

    /** A tapped notification opens its chat, or its topic without one. */
    private fun take(intent: Intent) {
        val workspace = intent.getStringExtra(WORKSPACE) ?: return
        val chat = intent.getStringExtra(CHAT)
        val topic = intent.getStringExtra(TOPIC) ?: return
        session.tapped = Tapped(workspace, chat?.let { Destination.Chat(it) } ?: Destination.Topic(topic))
        intent.removeExtra(WORKSPACE)
    }

    companion object {
        const val WORKSPACE = "workspaceId"
        const val TOPIC = "topicId"
        const val CHAT = "chatId"
    }
}
