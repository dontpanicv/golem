package dev.golem.phone

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.provider.Settings
import kotlinx.serialization.Serializable
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** The phone itself: links, the clipboard, its state, the flashlight, and the brightness. */
object PhoneDevice {
    @Serializable
    private data class OpenArguments(val url: String)

    @Serializable
    private data class ClipboardArguments(val text: String? = null)

    @Serializable
    private data class FlashlightArguments(val on: Boolean, val level: Double? = null)

    @Serializable
    private data class BrightnessArguments(val level: Double)

    @Serializable
    private data class Status(
        val batteryPercent: Int? = null,
        val battery: String,
        val lowPowerMode: Boolean,
        val model: String,
        val android: String,
        val freeStorageGb: Double? = null,
        val brightness: Double? = null,
        val thermalState: String,
        val network: String,
    )

    suspend fun open(phone: Phone): PhoneAnswer {
        val text = phone.arguments<OpenArguments>().url
        val uri = Uri.parse(text)
        if (uri.scheme.isNullOrEmpty()) throw PhoneError("$text is not a URL.")
        return PhoneAnswer("Opening $text.") { phone.activity.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
    }

    suspend fun clipboard(phone: Phone): PhoneAnswer {
        val text = phone.arguments<ClipboardArguments>().text
        val clipboard = phone.activity.getSystemService(ClipboardManager::class.java)
        if (text != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("Golem", text))
            return PhoneAnswer("Copied.")
        }
        val copied = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(phone.activity)?.toString()
        return PhoneAnswer(copied?.ifEmpty { null } ?: "The clipboard has no text.")
    }

    @Suppress("RedundantSuspendModifier")
    suspend fun status(phone: Phone): PhoneAnswer {
        val context = phone.context
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val percent = context.getSystemService(BatteryManager::class.java).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val power = context.getSystemService(PowerManager::class.java)
        val window = phone.activity.window.attributes.screenBrightness
        val brightness = if (window >= 0) window.toDouble()
        else runCatching { Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS) / 255.0 }.getOrNull()
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val network = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        return jsonAnswer(
            Status(
                batteryPercent = percent.takeIf { it in 0..100 },
                battery = when (battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
                    BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
                    BatteryManager.BATTERY_STATUS_FULL -> "full"
                    BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
                    else -> "unknown"
                },
                lowPowerMode = power.isPowerSaveMode,
                model = "${Build.MANUFACTURER} ${Build.MODEL}",
                android = Build.VERSION.RELEASE,
                freeStorageGb = runCatching { (StatFs(Environment.getDataDirectory().path).availableBytes / 1e8).roundToLong() / 10.0 }
                    .getOrNull(),
                brightness = brightness?.let { (it * 100).roundToInt() / 100.0 },
                thermalState = when (power.currentThermalStatus) {
                    PowerManager.THERMAL_STATUS_NONE, PowerManager.THERMAL_STATUS_LIGHT -> "nominal"
                    PowerManager.THERMAL_STATUS_MODERATE -> "fair"
                    PowerManager.THERMAL_STATUS_SEVERE -> "serious"
                    else -> "critical"
                },
                network = when {
                    network == null -> "none"
                    network.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                    network.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    network.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                    else -> "other"
                },
            )
        )
    }

    suspend fun flashlight(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<FlashlightArguments>()
        val cameras = phone.context.getSystemService(CameraManager::class.java)
        val id = cameras.cameraIdList.firstOrNull {
            val camera = cameras.getCameraCharacteristics(it)
            camera.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true &&
                camera.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        } ?: throw PhoneError("This phone has no flashlight.")
        val strongest = cameras.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL) ?: 1
        val level = arguments.level
        if (arguments.on && level != null && strongest > 1) {
            cameras.turnOnTorchWithStrengthLevel(id, (level.coerceIn(0.1, 1.0) * strongest).roundToInt().coerceIn(1, strongest))
        } else {
            cameras.setTorchMode(id, arguments.on)
        }
        return PhoneAnswer(if (arguments.on) "The flashlight is on." else "The flashlight is off.")
    }

    suspend fun brightness(phone: Phone): PhoneAnswer {
        val level = phone.arguments<BrightnessArguments>().level
        val window = phone.activity.window
        window.attributes = window.attributes.apply { screenBrightness = level.coerceIn(0.0, 1.0).toFloat() }
        return PhoneAnswer("Brightness set while Golem is open.")
    }
}
