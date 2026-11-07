package dev.golem.phone

import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The camera: the person takes a photo in the phone's camera app, and the agent looks at it. */
object PhoneCamera {
    @Serializable
    private data class Arguments(val mode: String? = null)

    suspend fun take(phone: Phone): PhoneAnswer {
        val document = phone.arguments<Arguments>().mode == "document"
        val context = phone.context
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) throw PhoneError("This phone has no camera.")
        val file = File(File(context.cacheDir, "camera").apply { mkdirs() }, "${UUID.randomUUID()}.jpg")
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            val taken = phone.result(ActivityResultContracts.TakePicture(), uri)
            if (!taken || file.length() == 0L) return PhoneAnswer("The person closed the camera without a picture.")
            val image = withContext(Dispatchers.IO) {
                jpeg(ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
                    val scale = min(1.0, LONGEST / max(info.size.width, info.size.height).toDouble())
                    decoder.setTargetSize((info.size.width * scale).roundToInt(), (info.size.height * scale).roundToInt())
                })
            }
            // Android gives other apps no document scanner, so a document is one photo of its page.
            val text = if (document) "The person took a photo of the page." else "The person took a photo."
            return PhoneAnswer(text, listOf(image))
        } finally {
            file.delete()
        }
    }

    /** The picture at most 1600 pixels on its longer side, as JPEG. */
    fun jpeg(bitmap: Bitmap): ByteArray {
        val scale = min(1.0, LONGEST / max(bitmap.width, bitmap.height).toDouble())
        val scaled = if (scale < 1) {
            Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).roundToInt(), (bitmap.height * scale).roundToInt(), true)
        } else bitmap
        return ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
    }

    private const val LONGEST = 1600.0
}
