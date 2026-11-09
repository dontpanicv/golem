package dev.golem.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// The calls and models of Settings, Workspace settings, and Topic details: integrations, places, machines, what
// Golem learned, usage, the LLM provider, and a topic's routines (docs/api.md).

// Integrations

@Serializable
data class Credential(
    val id: String,
    val label: String,
    /** The person who connected it; only they share, watch, or delete it. */
    val ownerId: String,
    val ownerName: String,
    /** Whether every member's turns use it; else only its owner's. */
    val shared: Boolean = false,
    /** Whether its owner lets Golem read it for them. */
    val watched: Boolean = false,
    val createdAt: Double = 0.0,
)

@Serializable
data class Integration(
    val id: String,
    val name: String,
    /** "secret", "sign-in", or "phone". */
    val connect: String,
    val secretLabel: String? = null,
    /** Whether the person names a credential; else Golem names it from the secret. */
    val labeled: Boolean = false,
    /** Whether the secret, or the sign-in, also needs the address of the person's own server. */
    val address: Boolean = false,
    /** The name of the account that the secret also needs, such as "Email". */
    val username: String? = null,
    /** The steps that set it up, in Markdown. */
    val guide: List<String> = emptyList(),
    val watchable: Boolean = false,
    /** Golem's own OAuth client, which the server's owner sets; null for integrations without one. */
    val client: Client? = null,
    val credentials: List<Credential> = emptyList(),
) {
    @Serializable
    data class Client(val clientId: String? = null, val changeable: Boolean = false)
}

/** The code that links a phone number, which the person enters on their phone. */
@Serializable
data class LinkCode(val code: String)

private fun integrationPath(workspaceId: String, integrationId: String) =
    "/api/v1/workspaces/$workspaceId/integrations/$integrationId"

suspend fun Api.integrations(workspaceId: String): List<Integration> = get("/api/v1/workspaces/$workspaceId/integrations")

/** The integration's sign-in page; `server` is the address of the person's own server, for an integration with `address`. */
suspend fun Api.connectIntegration(workspaceId: String, integrationId: String, server: String? = null): ConnectPage =
    post("${integrationPath(workspaceId, integrationId)}/connect", if (server != null) Api.body("address" to server) else Api.body())

/** Finishes a sign-in with the address where the integration's page ended. */
suspend fun Api.finishSignIn(workspaceId: String, integrationId: String, address: String): Credential =
    post("${integrationPath(workspaceId, integrationId)}/sign-in", Api.body("address" to address))

/** The code that the person enters on the phone of `phone`; `finishLink` waits until they did. */
suspend fun Api.linkIntegration(workspaceId: String, integrationId: String, phone: String): LinkCode =
    post("${integrationPath(workspaceId, integrationId)}/connect", Api.body("phone" to phone))

suspend fun Api.finishLink(workspaceId: String, integrationId: String): Credential =
    post("${integrationPath(workspaceId, integrationId)}/sign-in", Api.body())

/** `fields` has the `secret`, and the `label`, `address`, and `username` that the integration needs. */
suspend fun Api.addCredential(workspaceId: String, integrationId: String, fields: Map<String, String>): Credential =
    post("${integrationPath(workspaceId, integrationId)}/credentials", Api.body(*fields.toList().toTypedArray()))

/** Sets the OAuth client that Golem signs in to an integration with; only the server's owner may. */
suspend fun Api.setIntegrationClient(integrationId: String, clientId: String, clientSecret: String) {
    send("PUT", "/api/v1/integrations/$integrationId/client", Api.body("clientId" to clientId, "clientSecret" to clientSecret))
}

/** Changes `shared` or `watched` of the person's own credential. */
suspend fun Api.setCredential(workspaceId: String, credentialId: String, change: Pair<String, Boolean>): Credential =
    decode(send("PUT", "/api/v1/workspaces/$workspaceId/credentials/$credentialId", Api.body(change)))

suspend fun Api.deleteCredential(workspaceId: String, credentialId: String) {
    send("DELETE", "/api/v1/workspaces/$workspaceId/credentials/$credentialId")
}

// Places

@Serializable
data class Place(
    val id: String,
    val name: String,
    val latitude: Double,
    val longitude: Double,
    /** Meters, 100 to 5000. */
    val radius: Int,
    /** The person who added it; only they change or remove it. */
    val ownerId: String,
    val ownerName: String,
    val shared: Boolean = false,
)

@Serializable
private data class Places(val places: List<Place>)

/** The first place that OpenStreetMap's search finds for an address. */
@Serializable
data class FoundAddress(val latitude: Double, val longitude: Double, val label: String = "")

suspend fun Api.places(workspaceId: String): List<Place> = get<Places>("/api/v1/workspaces/$workspaceId/places").places

/** Adds a place, or changes the person's own place when `placeId` is set. */
suspend fun Api.savePlace(
    workspaceId: String, placeId: String?, name: String, latitude: Double, longitude: Double, radius: Int, shared: Boolean,
): Place {
    val path = "/api/v1/workspaces/$workspaceId/places"
    val body = Api.body("name" to name, "latitude" to latitude, "longitude" to longitude, "radius" to radius, "shared" to shared)
    return decode(send(if (placeId == null) "POST" else "PUT", placeId?.let { "$path/$it" } ?: path, body))
}

suspend fun Api.removePlace(workspaceId: String, placeId: String) {
    send("DELETE", "/api/v1/workspaces/$workspaceId/places/$placeId")
}

suspend fun Api.findAddress(query: String): FoundAddress =
    get(url("/api/v1/map/search").newBuilder().addQueryParameter("q", query).build())

/** An OpenStreetMap tile, which Golem gets for the app. */
fun Api.mapTileUrl(zoom: Int, x: Int, y: Int): String = url("/api/v1/map/$zoom/$x/$y").toString()

// Machines

@Serializable
data class Machine(
    val id: String,
    val name: String,
    @SerialName("os") val system: String = "",
    val arch: String = "",
    val version: String = "",
    /** The person who paired it; only they share or remove it. */
    val pairedBy: String,
    val pairedByName: String = "",
    val shared: Boolean = false,
) {
    /** "macOS arm64 · hands 0.5.0" */
    val summary: String
        get() = "${mapOf("macos" to "macOS", "linux" to "Linux")[system] ?: system} $arch · hands $version"
}

@Serializable
data class Pairing(val command: String, val expiresAt: Double)

@Serializable
data class Machines(val machines: List<Machine>, val pairing: Pairing? = null)

suspend fun Api.machines(workspaceId: String): Machines = get("/api/v1/workspaces/$workspaceId/machines")
suspend fun Api.startPairing(workspaceId: String): Pairing = post("/api/v1/workspaces/$workspaceId/machines/pairing")
suspend fun Api.setMachineShared(workspaceId: String, machineId: String, shared: Boolean): Machine =
    decode(send("PUT", "/api/v1/workspaces/$workspaceId/machines/$machineId", Api.body("shared" to shared)))
suspend fun Api.removeMachine(workspaceId: String, machineId: String) {
    send("DELETE", "/api/v1/workspaces/$workspaceId/machines/$machineId")
}

// What Golem learned

/**
 * A fact about a person (`about`), or how to do a task in a topic, or in the person's orchestrator when `topicId`
 * is null (`howto`). `realm` is the person who alone sees it; null for every member.
 */
@Serializable
data class Learned(
    val id: Int,
    val kind: String,
    val personId: String? = null,
    val topicId: String? = null,
    val realm: String? = null,
    val text: String,
    val chatId: String? = null,
    val updatedAt: Double = 0.0,
)

@Serializable
private data class LearnedList(val learned: List<Learned>)

/** Facts first. */
suspend fun Api.learned(workspaceId: String): List<Learned> = get<LearnedList>("/api/v1/workspaces/$workspaceId/learned").learned
suspend fun Api.setLearned(workspaceId: String, id: Int, text: String): Learned =
    decode(send("PUT", "/api/v1/workspaces/$workspaceId/learned/$id", Api.body("text" to text)))
/** Golem does not learn it again. */
suspend fun Api.deleteLearned(workspaceId: String, id: Int) {
    send("DELETE", "/api/v1/workspaces/$workspaceId/learned/$id")
}

// Usage

/**
 * Tokens and the cost in US dollars at the model's list price. `input` leaves out `cacheRead`. A row of a list has its
 * own key too: `day` ("YYYY-MM-DD" in UTC), `source`, `model`, `chatId` and `title`, or `userId` and `name`.
 */
@Serializable
data class UsageTotals(
    val input: Double = 0.0,
    val output: Double = 0.0,
    val cacheRead: Double = 0.0,
    val cacheWrite: Double = 0.0,
    val cost: Double = 0.0,
    val day: String? = null,
    val source: String? = null,
    val model: String? = null,
    val chatId: String? = null,
    val title: String? = null,
    val userId: String? = null,
    val name: String? = null,
) {
    val tokens get() = input + output + cacheRead + cacheWrite
    /** The part of the prompt that came from the cache. */
    val cacheRate get() = if (input + cacheRead == 0.0) 0.0 else cacheRead / (input + cacheRead)
}

@Serializable
data class Usage(
    /** Oldest first; a day without use is left out. */
    val days: List<UsageTotals> = emptyList(),
    val total: UsageTotals = UsageTotals(),
    val sources: List<UsageTotals> = emptyList(),
    val models: List<UsageTotals> = emptyList(),
    val chats: List<UsageTotals> = emptyList(),
    /** Only for the server's owner. */
    val people: List<UsageTotals>? = null,
)

/** The person's own use of the last `days` days; the server's owner gets everyone's. */
suspend fun Api.usage(workspaceId: String, days: Int): Usage = get("/api/v1/workspaces/$workspaceId/usage?days=$days")

// LLM provider

@Serializable
data class Llm(
    val connected: Boolean = false,
    /** Whether the person is the server's owner, who alone changes the login, the model, and the effort. */
    val owner: Boolean = false,
    val provider: String = "",
    val model: String = "",
    val effort: String = "",
    val models: List<Model> = emptyList(),
    val login: Login? = null,
    val error: String? = null,
) {
    @Serializable
    data class Login(val userCode: String, val verificationUri: String, val expiresAt: Double = 0.0)

    @Serializable
    data class Model(val id: String, val name: String, val efforts: List<String> = emptyList())
}

suspend fun Api.llm(): Llm = get("/api/v1/llm")
suspend fun Api.llmLogin(): Llm = post("/api/v1/llm/login")
suspend fun Api.llmLogout(): Llm = post("/api/v1/llm/logout")
suspend fun Api.setModel(model: String): Llm = decode(send("PUT", "/api/v1/llm/model", Api.body("model" to model)))
suspend fun Api.setEffort(effort: String): Llm = decode(send("PUT", "/api/v1/llm/effort", Api.body("effort" to effort)))

/** Restarts Golem, which then reads its configuration again. */
suspend fun Api.restartServer() {
    send("POST", "/api/v1/server/restart")
}
