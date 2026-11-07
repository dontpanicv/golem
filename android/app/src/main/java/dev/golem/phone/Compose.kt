package dev.golem.phone

import android.content.Intent
import android.net.Uri
import kotlinx.serialization.Serializable

/**
 * Messages, mail, and calls: Android fills them in, in the person's own apps, and the person sends or dials. Android
 * does not tell another app whether the person sent it, and the other app closes Golem's stream, so the tool answers
 * before it opens the app.
 */
object Compose {
    @Serializable
    private data class MessageArguments(val recipients: List<String>, val body: String)

    @Serializable
    private data class MailArguments(val to: List<String>, val cc: List<String>? = null, val subject: String, val body: String)

    @Serializable
    private data class CallArguments(val to: String, val kind: String? = null)

    suspend fun message(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<MessageArguments>()
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + arguments.recipients.joinToString(";") { Uri.encode(it) }))
            .putExtra("sms_body", arguments.body)
        if (intent.resolveActivity(phone.context.packageManager) == null) throw PhoneError("This phone cannot send messages.")
        return PhoneAnswer("The messaging app shows the message; the person taps Send there.") { phone.activity.startActivity(intent) }
    }

    suspend fun mail(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<MailArguments>()
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"))
            .putExtra(Intent.EXTRA_EMAIL, arguments.to.toTypedArray())
            .putExtra(Intent.EXTRA_CC, arguments.cc.orEmpty().toTypedArray())
            .putExtra(Intent.EXTRA_SUBJECT, arguments.subject)
            .putExtra(Intent.EXTRA_TEXT, arguments.body)
        if (intent.resolveActivity(phone.context.packageManager) == null) throw PhoneError("This phone has no email app.")
        return PhoneAnswer("The email app shows the email; the person taps Send there.") { phone.activity.startActivity(intent) }
    }

    suspend fun call(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<CallArguments>()
        if ((arguments.kind ?: "phone") != "phone") throw PhoneError("FaceTime is only on Apple devices; call the number instead.")
        val number = arguments.to.filterNot { it.isWhitespace() }
        if (number.isEmpty()) throw PhoneError("${arguments.to} is not callable.")
        val intent = Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))
        return PhoneAnswer("The phone app shows ${arguments.to}; the person taps Call.") { phone.activity.startActivity(intent) }
    }
}
