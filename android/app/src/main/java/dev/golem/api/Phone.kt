package dev.golem.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.nio.file.Files

/** A call of an agent's `phone_<name>` tool (docs/api.md, Phone); `name` has no `phone_`. */
@Serializable
data class PhoneCall(
    val id: String,
    val workspaceId: String,
    val name: String,
    val arguments: JsonObject = JsonObject(emptyMap()),
)

/** Reads the calls for the person's phone until the stream ends, the coroutine is cancelled, or an error occurs. */
suspend fun Api.phoneCalls(onCall: (PhoneCall) -> Unit) =
    events("/api/v1/phone/calls", "call") { onCall(json.decodeFromString(it)) }

/** Answers a call with text and JPEG pictures. */
suspend fun Api.answerPhoneCall(id: String, text: String, images: List<ByteArray>) {
    val path = "/api/v1/phone/calls/$id"
    if (images.isEmpty()) {
        send("POST", path, Api.body("text" to text))
        return
    }
    val folder = Files.createTempDirectory("phone").toFile()
    try {
        val files = images.mapIndexed { index, image -> File(folder, "${index + 1}.jpg").apply { writeBytes(image) } }
        sendForm(path, mapOf("text" to text), files)
    } finally {
        folder.deleteRecursively()
    }
}

/** Answers a call with the error that its tool fails with. */
suspend fun Api.answerPhoneCall(id: String, error: String) {
    send("POST", "/api/v1/phone/calls/$id", Api.body("error" to error))
}
