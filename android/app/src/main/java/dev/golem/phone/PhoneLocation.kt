package dev.golem.phone

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.location.Geocoder
import android.location.LocationManager
import android.net.Uri
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlin.coroutines.resume
import kotlin.math.roundToInt

/**
 * Where the phone is now (fused location of Play services) and directions in the maps app. Golem keeps no location:
 * the answer goes only to the turn that asked.
 */
object PhoneLocation {
    @Serializable
    private data class Here(val latitude: Double, val longitude: Double, val accuracyMeters: Int, val address: String? = null)

    @Serializable
    private data class DirectionsArguments(val destination: String, val mode: String? = null)

    @SuppressLint("MissingPermission")
    suspend fun current(phone: Phone): PhoneAnswer {
        val context = phone.context
        val fine = Manifest.permission.ACCESS_FINE_LOCATION
        val coarse = Manifest.permission.ACCESS_COARSE_LOCATION
        // The person may allow only the approximate location.
        try {
            phone.allow("the location", fine, coarse)
        } catch (error: PhoneError) {
            if (!phone.granted(coarse)) throw error
        }
        if (!context.getSystemService(LocationManager::class.java).isLocationEnabled) throw PhoneError("Location is off on the phone.")
        val token = CancellationTokenSource()
        val location = try {
            LocationServices.getFusedLocationProviderClient(context)
                .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, token.token).await()
        } finally {
            token.cancel()
        } ?: throw PhoneError("The phone found no location.")
        val address = if (Geocoder.isPresent()) withTimeoutOrNull(5_000) {
            suspendCancellableCoroutine<String?> { continuation ->
                Geocoder(context).getFromLocation(location.latitude, location.longitude, 1, object : Geocoder.GeocodeListener {
                    override fun onGeocode(addresses: MutableList<android.location.Address>) =
                        continuation.resume(addresses.firstOrNull()?.getAddressLine(0))
                    override fun onError(errorMessage: String?) = continuation.resume(null)
                })
            }
        } else null
        return jsonAnswer(Here(location.latitude, location.longitude, location.accuracy.roundToInt(), address))
    }

    suspend fun directions(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<DirectionsArguments>()
        val mode = when (arguments.mode ?: "driving") {
            "walking" -> "walking"
            "transit" -> "transit"
            "cycling" -> "bicycling"
            else -> "driving"
        }
        val uri = Uri.parse("https://www.google.com/maps/dir/").buildUpon()
            .appendQueryParameter("api", "1")
            .appendQueryParameter("destination", arguments.destination)
            .appendQueryParameter("travelmode", mode)
            .build()
        return PhoneAnswer("Maps shows the way to ${arguments.destination}.") {
            phone.activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
        }
    }
}
