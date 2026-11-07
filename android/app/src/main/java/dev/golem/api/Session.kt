package dev.golem.api

import android.content.Context
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.golem.BuildConfig
import dev.golem.notifications.Notifier
import dev.golem.places.PlaceWatcher
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom

/** A screen of the app; `key` is what the app remembers, so it opens on the last channel or thread. */
sealed interface Destination {
    data object Search : Destination
    data class Channel(val id: String) : Destination
    /** A channel with its composer focused, to start a thread. */
    data class NewThread(val id: String) : Destination
    /** A channel with one of its artifacts open, or the orchestrator with one of the workspace's own for a null channel. */
    data class Artifact(val channel: String?, val artifact: String) : Destination
    data class ChannelDetails(val id: String) : Destination
    data class Thread(val id: String) : Destination
    data object Inbox : Destination
    data object Upcoming : Destination
    data object Following : Destination
    data object Feedback : Destination
    data object WorkspaceSettings : Destination
    data object Settings : Destination
}

/** The toast at the bottom of the screen: the last failure of an action, or a confirmation. */
data class Toast(val message: String, val tone: Tone = Tone.Neutral, val id: Long = System.nanoTime()) {
    enum class Tone { Neutral, Success, Error }
}

/** A push the person tapped, or a notification of the app: the screen it opens, once its workspace is open. */
data class Tapped(val workspaceId: String, val destination: Destination)

/**
 * The signed-in person, their workspaces, and the open workspace with its channels. Every screen reads the server
 * through it; its state is Compose state, so screens redraw when it changes.
 */
class Session(private val context: Context, val scope: CoroutineScope) {
    val store = SecureStore(context)
    val api = Api()
    private val preferences = context.getSharedPreferences("app", Context.MODE_PRIVATE)
    val notifier = Notifier(context)
    val dictation by lazy { dev.golem.voice.Dictation(context) }

    var serverUrl by mutableStateOf(store.serverUrl ?: BuildConfig.SERVER_URL)
        private set
    var signedIn by mutableStateOf(store.token != null)
        private set
    var user by mutableStateOf<User?>(null)
        private set
    var workspaces by mutableStateOf<List<Workspace>>(emptyList())
        private set
    /** Whether the person is the server's owner, who reads the agents' feedback. */
    var owner by mutableStateOf(false)
        private set
    var workspace by mutableStateOf<Workspace?>(null)
        private set
    var channels by mutableStateOf<List<Channel>>(emptyList())
        private set
    var members by mutableStateOf<List<Member>>(emptyList())
        private set
    /** The open workspace's thread that never ends, which channel lists leave out. */
    var orchestrator by mutableStateOf<ThreadSummary?>(null)
        private set
    /** The threads of the open workspace whose agent works. */
    var working by mutableStateOf<Set<String>>(emptySet())
        private set
    var inbox by mutableStateOf<Inbox?>(null)
        private set
    /** The last failure of `load()`, shown with a retry button while no person is loaded. */
    var loadError by mutableStateOf<String?>(null)
        private set
    var toast by mutableStateOf<Toast?>(null)
    /** A tapped notification's screen, which the shell opens. */
    var tapped by mutableStateOf<Tapped?>(null)
    /** Changes when the workspace loads again, so lists that depend on it load again too. */
    var revision by mutableIntStateOf(0)
        private set
    /** The thread on screen, whose notifications the app does not show. */
    var threadOnScreen: String? = null

    /** The path of each member's profile picture in the open workspace, by person. */
    val pictures: Map<String, String> get() = members.mapNotNull { m -> m.picture?.let { m.userId to it } }.toMap()

    init {
        api.baseUrl = serverUrl
        api.token = store.token
        api.onUnauthorized = { scope.launch { clear() } }
    }

    fun setServer(url: String) {
        serverUrl = url
        api.baseUrl = url
        store.serverUrl = url
    }

    // Sign-in

    /** The sign-in that waits for its Auth Tab to come back with the `signed-in` address, or null when cancelled. */
    private var signInResult: CompletableDeferred<Uri?>? = null

    /**
     * Signs in with Google in an Auth Tab, which `launch` opens at the address with the host and path to return to.
     * The tab returns only to the server's https address, which Digital Asset Links give to this app, with a one-time
     * code that gives the token only with this sign-in's verifier (PKCE).
     */
    suspend fun signIn(launch: (Uri, String, String) -> Unit) {
        val verifier = newVerifier()
        val url = api.googleSignInUrl(challenge(verifier))
        if (!url.isHttps) throw ApiException(0, "Sign-in needs the server's https address.")
        val result = CompletableDeferred<Uri?>()
        signInResult = result
        launch(Uri.parse(url.toString()), url.host, SIGNED_IN)
        val callback = result.await() ?: return
        val code = callback.getQueryParameter("code")
            ?: throw ApiException(0, callback.getQueryParameter("error") ?: "Sign-in failed")
        finishSignIn(api.signInToken(code, verifier))
    }

    /** The Auth Tab's result: the address it returned to, or null when the person closed it. */
    fun signInReturned(uri: Uri?) {
        signInResult?.complete(uri)
        signInResult = null
    }

    /** Keeps a token, as a sign-in gives it, and loads the person. */
    fun finishSignIn(token: String) {
        store.token = token
        api.token = token
        signedIn = true
    }

    suspend fun signOut() {
        PlaceWatcher.stop(context)
        runCatching { api.signOut() }
        clear()
    }

    // Loading

    /** Loads the person and the workspaces, then opens the last workspace. */
    suspend fun load() {
        try {
            val profile = api.me()
            user = profile.user
            workspaces = profile.workspaces
            owner = profile.owner
            loadError = null
            val last = preferences.getString(WORKSPACE, null)
            (profile.workspaces.firstOrNull { it.id == last } ?: profile.workspaces.firstOrNull())?.let { open(it) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!signedIn) return
            if (user == null) loadError = error.message ?: "Golem is not reachable" else show(error.message ?: "", Toast.Tone.Error)
        }
    }

    suspend fun open(workspace: Workspace) {
        val detail = api.workspace(workspace.id)
        val orchestrator = api.orchestrator(workspace.id)
        val members = api.members(workspace.id)
        val opened = this.workspace?.id != detail.workspace.id
        this.workspace = detail.workspace
        this.members = members
        channels = detail.channels
        this.orchestrator = orchestrator
        preferences.edit().putString(WORKSPACE, workspace.id).apply()
        revision++
        runCatching { loadInbox() }
        if (opened) scope.launch { watchPlaces() }
    }

    /** Watches the places of the person's pending reminders and routines at a place in the open workspace. */
    suspend fun watchPlaces() {
        val workspace = workspace ?: return
        val places = runCatching { api.watchedPlaces(workspace.id) }.getOrElse { if (it is CancellationException) throw it else return }
        PlaceWatcher.watch(context, places, workspace.id)
    }

    suspend fun reloadWorkspace() {
        workspace?.let { open(it) }
    }

    // Notifications

    /** Loads the open workspace's notifications, and shows the new unread ones as notifications of the phone. */
    suspend fun loadInbox() {
        val workspace = workspace ?: return
        update(api.inbox(workspace.id))
    }

    /** Marks one notification read, or all of the open workspace's for a null `id`. */
    suspend fun readNotifications(id: String?) {
        val workspace = workspace ?: return
        update(api.readNotifications(workspace.id, id))
    }

    private fun update(inbox: Inbox) {
        val first = this.inbox == null
        this.inbox = inbox
        notifier.show(inbox, workspace?.id ?: return, silently = first, onScreen = threadOnScreen)
    }

    /** The screen of the notification the person tapped, once its workspace is open; it opens that workspace first. */
    fun takeTapped(): Destination? {
        val tapped = tapped ?: return null
        val workspace = workspace ?: return null
        if (tapped.workspaceId == workspace.id) {
            this.tapped = null
            return tapped.destination
        }
        val other = workspaces.firstOrNull { it.id == tapped.workspaceId }
        if (other != null) scope.launch { run { open(other) } } else this.tapped = null
        return null
    }

    /**
     * Follows which threads of the open workspace work, reading the stream again after each error, until cancelled.
     * The channels, threads, and notifications load again when work starts or ends, or a thread settles.
     */
    suspend fun followWorking() {
        working = emptySet()
        val workspace = workspace ?: return
        while (scope.isActive) {
            runCatching {
                api.workingEvents(workspace.id) { threadIds ->
                    working = threadIds.toSet()
                    scope.launch { runCatching { reloadWorkspace() } }
                }
            }.onFailure { if (it is CancellationException) throw it }
            delay(2_000)
        }
    }

    // Workspace changes

    suspend fun renameWorkspace(name: String) {
        val workspace = workspace ?: return
        val renamed = api.renameWorkspace(workspace.id, name)
        this.workspace = renamed
        workspaces = workspaces.map { if (it.id == renamed.id) renamed else it }
    }

    /** Makes a JPEG file the person's profile picture, or removes it for null. */
    suspend fun setPicture(file: File?) {
        if (file != null) api.uploadPicture(file) else api.removePicture()
        user = api.me().user
        reloadWorkspace()
    }

    /** Adds a channel; a private one only the person sees. */
    suspend fun createChannel(name: String, private: Boolean): Channel? {
        val workspace = workspace ?: return null
        val channel = api.createChannel(workspace.id, name, private)
        reloadWorkspace()
        return channel
    }

    suspend fun renameChannel(channelId: String, name: String) {
        val workspace = workspace ?: return
        api.renameChannel(workspace.id, channelId, name)
        reloadWorkspace()
    }

    /** Merges a channel into another; channels are never deleted. */
    suspend fun mergeChannel(channelId: String, into: String) {
        val workspace = workspace ?: return
        api.mergeChannel(workspace.id, channelId, into)
        reloadWorkspace()
    }

    suspend fun createThread(channelId: String, text: String, files: List<File>): ThreadSummary? {
        val workspace = workspace ?: return null
        val thread = api.createThread(workspace.id, channelId, text, files)
        reloadWorkspace()
        return thread
    }

    suspend fun setThreadSettled(threadId: String, settled: Boolean) {
        val workspace = workspace ?: return
        api.setThreadSettled(workspace.id, threadId, settled)
        reloadWorkspace()
    }

    suspend fun moveThread(threadId: String, channelId: String) {
        val workspace = workspace ?: return
        api.moveThread(workspace.id, threadId, channelId)
        reloadWorkspace()
    }

    /** Runs an action and shows its error in a toast. */
    suspend fun run(action: suspend () -> Unit) {
        try {
            action()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if ((error as? ApiException)?.status != 401) show(error.message ?: "Something went wrong", Toast.Tone.Error)
        }
    }

    /** Runs an action in the session's scope, as a button does. */
    fun launch(action: suspend () -> Unit) {
        scope.launch { run(action) }
    }

    fun show(message: String, tone: Toast.Tone = Toast.Tone.Neutral) {
        toast = Toast(message, tone)
    }

    private fun clear() {
        store.token = null
        api.token = null
        signedIn = false
        user = null
        workspaces = emptyList()
        workspace = null
        channels = emptyList()
        members = emptyList()
        orchestrator = null
        inbox = null
        loadError = null
        notifier.clear()
    }

    companion object {
        const val SIGNED_IN = "/api/v1/sign-in/google/signed-in"
        private const val WORKSPACE = "workspaceId"

        /** The base64url SHA-256 of a verifier, as RFC 7636 makes the challenge. */
        fun challenge(verifier: String): String =
            base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

        /** 32 random bytes, as base64url: the secret that only this sign-in knows. */
        fun newVerifier(): String = base64Url(ByteArray(32).also { SecureRandom().nextBytes(it) })

        private fun base64Url(bytes: ByteArray): String = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
