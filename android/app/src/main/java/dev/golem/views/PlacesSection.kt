package dev.golem.views

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.EditLocationAlt
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import coil3.compose.AsyncImage
import com.google.android.gms.location.LocationServices
import dev.golem.api.Place
import dev.golem.api.findAddress
import dev.golem.api.mapTileUrl
import dev.golem.api.places
import dev.golem.api.removePlace
import dev.golem.api.savePlace
import dev.golem.design.Golem
import dev.golem.design.GolemSwitch
import dev.golem.design.GolemTextField
import dev.golem.design.LocalSession
import dev.golem.design.MenuAction
import dev.golem.design.SettingsRow
import dev.golem.design.Tokens
import dev.golem.design.golemText
import kotlinx.coroutines.tasks.await
import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log2
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sinh
import kotlin.math.tan

/**
 * The person's own places, which they mark with a pin on a map and share with every member's turns or keep private,
 * and the ones other members shared. A reminder waits for a person to arrive at one or leave it.
 */
@Composable
fun PlacesSection(workspaceId: String) {
    val session = LocalSession.current
    var places by remember { mutableStateOf<List<Place>>(emptyList()) }
    var editing by remember { mutableStateOf<Place?>(null) }
    var adding by remember { mutableStateOf(false) }
    suspend fun load() {
        places = session.api.places(workspaceId)
    }

    LaunchedEffect(workspaceId) { session.run { load() } }

    SettingsGroup("Places") {
        places.forEach { place ->
            if (place.ownerId == session.user?.id) {
                SettingsRow(place.name, description = "${place.radius} m · ${if (place.shared) "Shared" else "Private"}") {
                    GolemSwitch(!place.shared, { private ->
                        session.launch {
                            val saved = session.api.savePlace(workspaceId, place.id, place.name, place.latitude, place.longitude,
                                place.radius, !private)
                            places = places.map { if (it.id == saved.id) saved else it }
                        }
                    }, label = "Private")
                    SettingsRowMenu("Place actions", listOf(
                        MenuAction("Change place", Icons.Outlined.EditLocationAlt) { editing = place },
                        MenuAction("Remove place", Icons.Outlined.Delete, danger = true) {
                            session.launch {
                                session.api.removePlace(workspaceId, place.id)
                                places = places.filter { it.id != place.id }
                            }
                        },
                    ))
                }
            } else {
                SettingsRow(place.name, description = "${place.radius} m · Shared by ${place.ownerName}")
            }
        }
        SettingsAddButton("Add place") { adding = true }
    }

    if (adding || editing != null) {
        PlaceForm(workspaceId, editing, onDismiss = { adding = false; editing = null }) { load() }
    }
}

/** The zoom that shows a few streets around a pin. */
private const val STREETS = 15f

/**
 * Adds a place or changes one: its name, the pin in the middle of the map, which an address moves to, and the radius
 * of its circle. It opens on the place, else on the phone's last location when the person allowed it.
 */
@SuppressLint("MissingPermission")
@Composable
private fun PlaceForm(workspaceId: String, place: Place?, onDismiss: () -> Unit, saved: suspend () -> Unit) {
    val session = LocalSession.current
    val context = LocalContext.current
    var name by remember { mutableStateOf(place?.name ?: "") }
    var address by remember { mutableStateOf("") }
    var radius by remember { mutableIntStateOf(place?.radius ?: 200) }
    val camera = remember {
        place?.let { MapCamera(it.latitude, it.longitude, STREETS) } ?: MapCamera(30.0, 0.0, 2f)
    }

    LaunchedEffect(Unit) {
        val allowed = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION).any {
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }
        if (place == null && allowed) {
            runCatching { LocationServices.getFusedLocationProviderClient(context).lastLocation.await() }.getOrNull()?.let {
                camera.moveTo(it.latitude, it.longitude, STREETS)
            }
        }
    }

    fun find() {
        val query = address.trim()
        if (query.isEmpty()) return
        session.launch {
            val found = session.api.findAddress(query)
            camera.moveTo(found.latitude, found.longitude, STREETS)
        }
    }

    BusyDialog(place?.name ?: "Add a place", if (place == null) "Add place" else "Save", onDismiss, enabled = name.isNotBlank(), act = {
        session.api.savePlace(workspaceId, place?.id, name.trim(), camera.latitude, camera.longitude, radius, place?.shared ?: false)
        saved()
    }) {
        GolemTextField(name, { name = it }, label = "Name", autofocus = place == null)
        GolemTextField(
            address, { address = it }, label = "Address", placeholder = "Street, town",
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { find() }),
        )
        PlaceMap(camera, radius)
        Column {
            Text(if (radius < 1000) "Radius · $radius m" else "Radius · ${"%.1f".format(radius / 1000.0)} km",
                style = golemText(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium), color = Golem.mobile.textSecondary)
            Slider(
                radius.toFloat(), { radius = (it / 50).roundToInt() * 50 }, valueRange = 100f..5000f,
                colors = SliderDefaults.colors(thumbColor = Golem.colors.accent, activeTrackColor = Golem.colors.accent,
                    inactiveTrackColor = Golem.mobile.fill),
                modifier = Modifier.semantics { contentDescription = "Radius" },
            )
        }
    }
}

/** Where the map looks: the point in its middle, as Web Mercator shares of the world, and its zoom. */
private class MapCamera(latitude: Double, longitude: Double, zoom: Float) {
    var x by mutableDoubleStateOf(Mercator.x(longitude))
    var y by mutableDoubleStateOf(Mercator.y(latitude))
    var zoom by mutableFloatStateOf(zoom)
    val latitude get() = Mercator.latitude(y)
    val longitude get() = Mercator.longitude(x)

    fun moveTo(latitude: Double, longitude: Double, zoom: Float) {
        x = Mercator.x(longitude)
        y = Mercator.y(latitude)
        this.zoom = zoom
    }

    /** Moves the map with a finger: the world goes along, so its middle goes the other way. */
    fun pan(by: Offset, tilePixels: Float) {
        val world = tilePixels * 2.0.pow(zoom.toDouble())
        x = ((x - by.x / world) % 1 + 1) % 1
        y = (y - by.y / world).coerceIn(0.0, 1.0)
    }

    fun zoomBy(factor: Float) {
        zoom = (zoom + log2(factor)).coerceIn(2f, MAX_ZOOM.toFloat())
    }
}

/** The highest zoom of the tiles that Golem serves. */
private const val MAX_ZOOM = 19

/** The size of an OpenStreetMap tile on screen; 256 dp keeps its labels as large as on the web. */
private val TILE = 256.dp

/**
 * An OpenStreetMap map, whose tiles come through Golem, with the place's pin in the middle and its circle: the map
 * moves under the pin, so a place always has one. One finger moves it, two zoom it, as do the buttons.
 */
@Composable
private fun PlaceMap(camera: MapCamera, radius: Int) {
    val session = LocalSession.current
    val tilePixels = with(LocalDensity.current) { TILE.toPx() }
    val accent = Golem.colors.accent
    BoxWithConstraints(
        Modifier.fillMaxWidth().height(Tokens.Size.map).clip(RoundedCornerShape(Tokens.Radius.md)).background(Golem.mobile.fill)
            .pointerInput(camera) {
                detectTransformGestures { _, pan, zoom, _ ->
                    camera.pan(pan, tilePixels)
                    if (zoom != 1f) camera.zoomBy(zoom)
                }
            }
            .semantics { contentDescription = "Map" },
    ) {
        val width = constraints.maxWidth.toDouble()
        val height = constraints.maxHeight.toDouble()
        val level = floor(camera.zoom).toInt().coerceIn(0, MAX_ZOOM)
        val shown = tilePixels * 2.0.pow((camera.zoom - level).toDouble())
        val count = 1 shl level
        val left = camera.x * count * shown - width / 2
        val top = camera.y * count * shown - height / 2
        val tileSize = with(LocalDensity.current) { shown.toFloat().toDp() }
        for (column in floor(left / shown).toInt()..floor((left + width) / shown).toInt()) {
            for (row in maxOf(0, floor(top / shown).toInt())..minOf(count - 1, floor((top + height) / shown).toInt())) {
                key(level, column, row) {
                    AsyncImage(
                        session.api.mapTileUrl(level, Math.floorMod(column, count), row), null,
                        Modifier.offset { IntOffset((column * shown - left).roundToInt(), (row * shown - top).roundToInt()) }.size(tileSize),
                    )
                }
            }
        }
        Canvas(Modifier.matchParentSize()) {
            val circle = (radius / Mercator.metersPerPixel(camera.latitude, tilePixels * 2.0.pow(camera.zoom.toDouble()))).toFloat()
            drawCircle(accent.copy(alpha = 0.12f), circle)
            drawCircle(accent, circle, style = Stroke(1.5.dp.toPx()))
            drawCircle(Color.White, 9.dp.toPx())
            drawCircle(accent, 7.dp.toPx())
        }
        Column(Modifier.align(Alignment.TopEnd).padding(Tokens.Space.xs)) {
            listOf(Icons.Outlined.Add to 2f, Icons.Outlined.Remove to 0.5f).forEach { (icon, factor) ->
                IconButton({ camera.zoomBy(factor) }) {
                    Box(Modifier.size(Tokens.Size.control).background(Golem.colors.surfaceRaised, RoundedCornerShape(Tokens.Radius.md)),
                        contentAlignment = Alignment.Center) {
                        Icon(icon, if (factor > 1) "Zoom in" else "Zoom out", Modifier.size(Tokens.Size.icon), tint = Golem.mobile.text)
                    }
                }
            }
        }
        Row(Modifier.align(Alignment.BottomEnd).background(Golem.colors.surfaceRaised.copy(alpha = 0.8f)),
            horizontalArrangement = Arrangement.End) {
            Text("© OpenStreetMap", style = golemText(Tokens.FontSize.xs), color = Golem.mobile.textSecondary,
                modifier = Modifier.padding(horizontal = Tokens.Space.xs))
        }
    }
}

/** Web Mercator, as OpenStreetMap's tiles: a point as the share of the world's width and height from the top left. */
object Mercator {
    fun x(longitude: Double) = (longitude + 180) / 360

    fun y(latitude: Double): Double {
        val radians = Math.toRadians(latitude.coerceIn(-85.0511, 85.0511))
        return (1 - ln(tan(radians) + 1 / cos(radians)) / PI) / 2
    }

    fun longitude(x: Double) = x * 360 - 180
    fun latitude(y: Double) = Math.toDegrees(atan(sinh(PI * (1 - 2 * y))))

    /** The meters on the ground of one pixel at `latitude`, for a world `worldPixels` wide. */
    fun metersPerPixel(latitude: Double, worldPixels: Double) = cos(Math.toRadians(latitude)) * 2 * PI * 6_378_137 / worldPixels
}
