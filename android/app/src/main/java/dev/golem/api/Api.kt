package dev.golem.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class ApiException(val status: Int, override val message: String) : IOException(message)

/** Gets the share of an upload's body sent so far, from 0 to 1. */
typealias UploadShare = (Double) -> Unit

/**
 * The Golem JSON API (docs/api.md). Sends the bearer token on every request to the server and reports a 401 to
 * `onUnauthorized`.
 */
class Api {
    @Volatile var baseUrl = ""
    @Volatile var token: String? = null
    var onUnauthorized: () -> Unit = {}

    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    /** Sends the token only to Golem's own address, also for the pictures that Coil loads. */
    private val bearer = Interceptor { chain ->
        val request = chain.request()
        val token = token
        val server = serverUrl()
        if (token == null || server == null || request.url.host != server.host || request.url.port != server.port) {
            chain.proceed(request)
        } else {
            chain.proceed(request.newBuilder().header("Authorization", "Bearer $token").build())
        }
    }

    val client: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(bearer)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    /** The event streams wait for their next event as long as the server keeps them open. */
    private val streams = client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()

    // Auth

    /** Opened in an Auth Tab; `challenge` is the base64url SHA-256 of the sign-in's verifier. */
    fun googleSignInUrl(challenge: String): HttpUrl =
        url("/api/v1/sign-in/google").newBuilder().addQueryParameter("challenge", challenge).build()

    /** Swaps the one-time code of a sign-in, with its verifier, for the session token. */
    suspend fun signInToken(code: String, verifier: String): String =
        post<TokenResponse>("/api/v1/sign-in/google/token", body("code" to code, "verifier" to verifier)).token
            ?: throw ApiException(0, "Sign-in failed")

    suspend fun signOut() {
        send("POST", "/api/auth/sign-out")
    }

    // Workspaces

    suspend fun me(): Profile = get("/api/v1/me")
    suspend fun workspace(id: String): WorkspaceDetail = get("/api/v1/workspaces/$id")
    suspend fun renameWorkspace(id: String, name: String): Workspace =
        decode(send("PUT", "/api/v1/workspaces/$id", body("name" to name)))
    suspend fun members(workspaceId: String): List<Member> = get("/api/v1/workspaces/$workspaceId/members")
    suspend fun addMember(workspaceId: String, email: String): Member =
        post("/api/v1/workspaces/$workspaceId/members", body("email" to email))
    suspend fun facts(workspaceId: String): Facts = get("/api/v1/workspaces/$workspaceId/facts")
    suspend fun setFacts(workspaceId: String, text: String): Facts =
        decode(send("PUT", "/api/v1/workspaces/$workspaceId/facts", body("text" to text)))

    /** Makes a JPEG, PNG, or WebP file the person's profile picture. */
    suspend fun uploadPicture(file: File) {
        sendForm("/api/v1/me/picture", emptyMap(), listOf(file))
    }

    suspend fun removePicture() {
        send("DELETE", "/api/v1/me/picture")
    }

    suspend fun orchestrator(workspaceId: String): ThreadSummary = get("/api/v1/workspaces/$workspaceId/orchestrator")

    suspend fun createChannel(workspaceId: String, name: String, private: Boolean): Channel =
        post("/api/v1/workspaces/$workspaceId/channels", body("name" to name, "private" to private))

    suspend fun renameChannel(workspaceId: String, channelId: String, name: String): Channel =
        decode(send("PUT", "/api/v1/workspaces/$workspaceId/channels/$channelId", body("name" to name)))

    suspend fun mergeChannel(workspaceId: String, channelId: String, into: String) {
        send("POST", "/api/v1/workspaces/$workspaceId/channels/$channelId/merge", body("into" to into))
    }

    suspend fun brief(workspaceId: String, channelId: String): Brief? =
        get<ChannelBrief>("/api/v1/workspaces/$workspaceId/channels/$channelId/brief").brief

    // Threads

    suspend fun createThread(
        workspaceId: String, channelId: String, text: String, files: List<File>, progress: UploadShare? = null,
    ): ThreadSummary = decode(
        sendForm(
            "/api/v1/workspaces/$workspaceId/threads", mapOf("channelId" to channelId, "text" to text), files, progress
        )
    )

    suspend fun thread(id: String): ThreadState = get("/api/v1/threads/$id")

    /** `voice`: spoken in a conversation, so the answer is written to be read aloud. */
    suspend fun sendMessage(
        threadId: String, text: String, files: List<File>, voice: Boolean = false, progress: UploadShare? = null,
    ) {
        val fields = if (voice) mapOf("text" to text, "voice" to "true") else mapOf("text" to text)
        sendForm("/api/v1/threads/$threadId/messages", fields, files, progress)
    }

    suspend fun setThreadSettled(workspaceId: String, threadId: String, settled: Boolean) {
        send("POST", "/api/v1/workspaces/$workspaceId/threads/$threadId/settled", body("settled" to settled))
    }

    suspend fun moveThread(workspaceId: String, threadId: String, channelId: String) {
        send("POST", "/api/v1/workspaces/$workspaceId/threads/$threadId/channel", body("channelId" to channelId))
    }

    /** Answers an approval; `scope` "turn" also allows the rest of the turn's changes on that machine. */
    suspend fun answerApproval(threadId: String, approvalId: String, allow: Boolean, scope: String = "once") {
        send("POST", "/api/v1/threads/$threadId/approvals/$approvalId", body("allow" to allow, "scope" to scope))
    }

    suspend fun stopThread(id: String) {
        send("POST", "/api/v1/threads/$id/stop")
    }

    /** Reads the thread's server-sent events until the stream ends, the coroutine is cancelled, or an error occurs. */
    suspend fun threadEvents(id: String, onState: (ThreadState) -> Unit) =
        events("/api/v1/threads/$id/events", "thread") { onState(json.decodeFromString(it)) }

    /** Reads which threads of a workspace work, at once and after every change. */
    suspend fun workingEvents(workspaceId: String, onThreads: (List<String>) -> Unit) =
        events("/api/v1/workspaces/$workspaceId/working", "working") {
            onThreads(json.decodeFromString<WorkingThreads>(it).threadIds)
        }

    // Files

    private fun filesPath(workspaceId: String, channelId: String?) =
        "/api/v1/workspaces/$workspaceId${channelId?.let { "/channels/$it" } ?: ""}/files"

    /** The files of a channel, or the workspace's own for a null `channelId`. */
    suspend fun files(workspaceId: String, channelId: String?): List<SavedFile> =
        get<SavedFiles>(filesPath(workspaceId, channelId)).files

    suspend fun uploadFiles(workspaceId: String, channelId: String?, files: List<File>): List<SavedFile> =
        decode<SavedFiles>(sendForm(filesPath(workspaceId, channelId), emptyMap(), files)).files

    /** Returns the files left where the file was. */
    suspend fun deleteFile(workspaceId: String, fileId: String): List<SavedFile> =
        decode<SavedFiles>(send("DELETE", "/api/v1/workspaces/$workspaceId/files/$fileId")).files

    fun fileUrl(workspaceId: String, fileId: String): String = url("/api/v1/workspaces/$workspaceId/files/$fileId").toString()

    /** A JPEG of a picture file at most 1024 pixels long, for its thumbnail in a message. */
    fun pictureUrl(workspaceId: String, fileId: String): String = "${fileUrl(workspaceId, fileId)}/picture"

    /** The address of a profile picture at the path that `User` or `Member` gives. */
    fun profilePictureUrl(path: String): String? = runCatching { url(path).toString() }.getOrNull()

    /** Downloads a file of the workspace to `folder` under its own name. */
    suspend fun download(workspaceId: String, file: FileRef, folder: File): File = withContext(Dispatchers.IO) {
        val response = client.newCall(request("/api/v1/workspaces/$workspaceId/files/${file.id}").build()).await()
        response.use {
            check(it)
            val name = file.name.ifEmpty {
                it.header("content-disposition")?.substringAfter("filename=\"", "")?.substringBefore('"')
                    ?.ifEmpty { null } ?: file.id
            }
            val target = File(folder.apply { mkdirs() }, name.replace('/', '_'))
            target.outputStream().use { out -> it.body.byteStream().copyTo(out) }
            target
        }
    }

    // Artifacts

    /** The artifacts of a channel, or the workspace's own for a null `channelId`. */
    suspend fun artifacts(workspaceId: String, channelId: String?): List<Artifact> =
        get<ArtifactList>(
            "/api/v1/workspaces/$workspaceId${channelId?.let { "/channels/$it" } ?: ""}/artifacts"
        ).artifacts

    suspend fun artifact(id: String): ArtifactDetail = get("/api/v1/artifacts/$id")
    suspend fun setArtifactVisibility(id: String, visibility: String): Artifact =
        decode(send("PUT", "/api/v1/artifacts/$id", body("visibility" to visibility)))
    suspend fun deleteArtifact(id: String) {
        send("DELETE", "/api/v1/artifacts/$id")
    }
    suspend fun deleteArtifactData(id: String) {
        send("DELETE", "/api/v1/artifacts/$id/data")
    }
    suspend fun deleteArtifactRecord(id: String, recordId: String) {
        send("DELETE", "/api/v1/artifacts/$id/records/$recordId")
    }

    /** A call of the artifact's `golem` runtime, as the signed-in person; returns the JSON of `result`. */
    suspend fun artifactRpc(id: String, call: JsonObject): JsonElement =
        json.parseToJsonElement(send("POST", "/api/v1/artifacts/$id/rpc", call)).jsonObject["result"] ?: JsonNull

    // Search

    suspend fun search(workspaceId: String, query: String): SearchResponse = get(
        url("/api/v1/workspaces/$workspaceId/search").newBuilder().addQueryParameter("q", query).build()
    )

    suspend fun recentSearches(workspaceId: String): RecentSearches = get("/api/v1/workspaces/$workspaceId/searches")
    suspend fun saveSearch(workspaceId: String, query: String): RecentSearches =
        post("/api/v1/workspaces/$workspaceId/searches", body("query" to query))

    // Notifications

    suspend fun inbox(workspaceId: String): Inbox = get("/api/v1/workspaces/$workspaceId/notifications")

    /** Marks one notification read, or all of the workspace's for a null `id`. */
    suspend fun readNotifications(workspaceId: String, id: String?): Inbox =
        post("/api/v1/workspaces/$workspaceId/notifications/read", if (id == null) body() else body("id" to id))

    // Transport

    suspend inline fun <reified T> get(path: String): T = decode(send("GET", path))
    suspend inline fun <reified T> get(url: HttpUrl): T = decode(send("GET", url))
    suspend inline fun <reified T> post(path: String, body: JsonObject? = null): T = decode(send("POST", path, body))
    inline fun <reified T> decode(text: String): T = json.decodeFromString(text)

    suspend fun send(method: String, path: String, body: JsonObject? = null): String =
        send(method, url(path), body)

    suspend fun send(method: String, url: HttpUrl, body: JsonObject? = null): String = withContext(Dispatchers.IO) {
        val requestBody = body?.toString()?.toRequestBody(JSON)
            ?: if (method == "POST" || method == "PUT") ByteArray(0).toRequestBody() else null
        val response = client.newCall(Request.Builder().url(url).method(method, requestBody).build()).await()
        response.use {
            val text = it.body.string()
            check(it, text)
            text
        }
    }

    /** A `multipart/form-data` post: the text fields, then one `files` part per file; `progress` gets the share sent. */
    suspend fun sendForm(
        path: String, fields: Map<String, String>, files: List<File>, progress: UploadShare? = null,
    ): String = withContext(Dispatchers.IO) {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
        fields.forEach { (name, value) -> form.addFormDataPart(name, value) }
        files.forEach { form.addFormDataPart("files", it.name, it.asRequestBody(OCTET_STREAM)) }
        val built = form.build()
        val requestBody = progress?.let { CountingBody(built, it) } ?: built
        val response = client.newCall(request(path).post(requestBody).build()).await()
        response.use {
            val text = it.body.string()
            check(it, text)
            text
        }
    }

    /**
     * Reads the server-sent events named `name` until the stream ends, the coroutine is cancelled, or an error occurs.
     * The server sends each event's JSON on one `data:` line.
     */
    suspend fun events(path: String, name: String, onEvent: (String) -> Unit) = withContext(Dispatchers.IO) {
        val call = streams.newCall(request(path).header("Accept", "text/event-stream").build())
        val response = call.await()
        response.use {
            check(it)
            val source = it.body.source()
            var event = ""
            while (true) {
                val line = source.readUtf8Line() ?: break
                if (line.startsWith("event:")) {
                    event = line.removePrefix("event:").trim()
                } else if (line.startsWith("data:") && event == name) {
                    val data = line.removePrefix("data:")
                    withContext(Dispatchers.Main) { onEvent(data) }
                }
            }
        }
    }

    fun request(path: String): Request.Builder = Request.Builder().url(url(path))

    /** The server's address, when it is valid: only TLS proves that the server is Golem before the token goes to it. */
    fun serverUrl(): HttpUrl? {
        val url = baseUrl.trim().trimEnd('/').toHttpUrlOrNull() ?: return null
        return url.takeIf { it.isHttps || it.host == "localhost" }
    }

    fun url(path: String): HttpUrl {
        val server = serverUrl() ?: throw ApiException(0, "The server address is not valid.")
        return "${server.toString().trimEnd('/')}$path".toHttpUrlOrNull()
            ?: throw ApiException(0, "The server address is not valid.")
    }

    fun check(response: Response, text: String? = null) {
        if (response.isSuccessful) return
        val sentToken = response.request.header("Authorization") != null
        if (response.code == 401 && sentToken) onUnauthorized()
        val body = text ?: runCatching { response.body.string() }.getOrNull()
        // `/api/v1` errors use `error`; better-auth errors under `/api/auth` use `message`.
        val message = body?.let { runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull() }?.let {
            (it["error"] ?: it["message"])?.jsonPrimitive?.contentOrNull
        }
        throw ApiException(response.code, message ?: response.message.ifEmpty { "Error ${response.code}" })
    }

    companion object {
        val JSON = "application/json".toMediaType()
        private val OCTET_STREAM = "application/octet-stream".toMediaType()

        /** A JSON object from pairs of names and values: text, numbers, booleans, null, lists, and JSON. */
        fun body(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.associate { (key, value) -> key to element(value) })

        fun element(value: Any?): JsonElement = when (value) {
            null -> JsonNull
            is JsonElement -> value
            is String -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            is List<*> -> JsonArray(value.map(::element))
            is Map<*, *> -> JsonObject(value.entries.associate { (key, item) -> key.toString() to element(item) })
            else -> JsonPrimitive(value.toString())
        }
    }
}

/** Waits for a call's response; cancelling the coroutine cancels the call. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = continuation.resume(response)
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
    })
}

/** A request body that tells how much of itself was written, as the share from 0 to 1. */
private class CountingBody(private val body: RequestBody, private val report: UploadShare) : RequestBody() {
    override fun contentType() = body.contentType()
    override fun contentLength() = body.contentLength()

    override fun writeTo(sink: BufferedSink) {
        val total = contentLength().toDouble()
        var written = 0L
        val counting = object : ForwardingSink(sink) {
            override fun write(source: Buffer, byteCount: Long) {
                super.write(source, byteCount)
                written += byteCount
                if (total > 0) report(written / total)
            }
        }.buffer()
        body.writeTo(counting)
        counting.flush()
    }
}
