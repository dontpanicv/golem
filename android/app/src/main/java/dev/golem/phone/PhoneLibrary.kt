package dev.golem.phone

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Size
import android.webkit.MimeTypeMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/**
 * The photos and videos of the phone (`MediaStore`): find them, look at one, and save the workspace's pictures and
 * videos. A photo's id is its content address.
 */
object PhoneLibrary {
    @Serializable
    private data class FindArguments(
        val from: String? = null,
        val to: String? = null,
        val kind: String? = null,
        val favorites: Boolean? = null,
        val limit: Int? = null,
    )

    @Serializable
    private data class PhotoArguments(val id: String)

    @Serializable
    private data class SaveArguments(val fileId: String)

    @Serializable
    private data class Row(
        val id: String,
        val date: String? = null,
        val kind: String,
        val favorite: Boolean,
        val width: Int,
        val height: Int,
        val seconds: Double? = null,
        val latitude: Double? = null,
        val longitude: Double? = null,
    )

    private val files = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
    private const val IMAGE = MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
    private const val VIDEO = MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO

    suspend fun find(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<FindArguments>()
        access(phone)
        val conditions = mutableListOf("${MediaStore.Files.FileColumns.MEDIA_TYPE} IN ($IMAGE, $VIDEO)")
        val values = mutableListOf<String>()
        arguments.from?.let { conditions += "${MediaStore.MediaColumns.DATE_TAKEN} >= ?"; values += date(it).toEpochMilli().toString() }
        arguments.to?.let { conditions += "${MediaStore.MediaColumns.DATE_TAKEN} < ?"; values += date(it).toEpochMilli().toString() }
        if (arguments.favorites == true) conditions += "${MediaStore.MediaColumns.IS_FAVORITE} = 1"
        when (arguments.kind) {
            null -> {}
            "photo" -> conditions += "${MediaStore.Files.FileColumns.MEDIA_TYPE} = $IMAGE"
            "video" -> conditions += "${MediaStore.Files.FileColumns.MEDIA_TYPE} = $VIDEO"
            "screenshot" -> conditions += "${MediaStore.Files.FileColumns.MEDIA_TYPE} = $IMAGE AND " +
                "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE '%Screenshots%'"
            "live" -> throw PhoneError("Android has no live photos; ask for photo or video.")
            else -> throw PhoneError("kind must be photo, video, screenshot, or live.")
        }
        val query = Bundle().apply {
            putString(ContentResolver.QUERY_ARG_SQL_SELECTION, conditions.joinToString(" AND "))
            putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, values.toTypedArray())
            putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, "${MediaStore.MediaColumns.DATE_TAKEN} DESC")
            putInt(ContentResolver.QUERY_ARG_LIMIT, (arguments.limit ?: 20).coerceIn(1, 100))
        }
        val resolver = phone.context.contentResolver
        val places = phone.granted(Manifest.permission.ACCESS_MEDIA_LOCATION)
        val rows = withContext(Dispatchers.IO) {
            resolver.query(
                files,
                arrayOf(MediaStore.MediaColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.MediaColumns.DATE_TAKEN,
                    MediaStore.MediaColumns.IS_FAVORITE, MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT,
                    MediaStore.MediaColumns.DURATION, MediaStore.MediaColumns.RELATIVE_PATH),
                query, null,
            )?.use { cursor ->
                cursor.rows {
                    val video = cursor.getInt(1) == VIDEO
                    val uri = ContentUris.withAppendedId(
                        if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        cursor.getLong(0),
                    )
                    val place = if (places && !video) place(resolver, uri) else null
                    Row(
                        id = uri.toString(),
                        date = if (cursor.isNull(2)) null else iso(cursor.getLong(2)),
                        kind = kind(video, cursor.getString(7)),
                        favorite = cursor.getInt(3) == 1,
                        width = cursor.getInt(4),
                        height = cursor.getInt(5),
                        seconds = if (video) cursor.getLong(6) / 1000.0 else null,
                        latitude = place?.get(0)?.toDouble(),
                        longitude = place?.get(1)?.toDouble(),
                    )
                }
            }.orEmpty()
        }
        return jsonAnswer(rows)
    }

    suspend fun photo(phone: Phone): PhoneAnswer {
        val id = phone.arguments<PhotoArguments>().id
        val uri = Uri.parse(id).takeIf { it.scheme == "content" && it.authority == MediaStore.AUTHORITY }
            ?: throw PhoneError("There is no photo $id.")
        access(phone)
        val resolver = phone.context.contentResolver
        return withContext(Dispatchers.IO) {
            val (taken, path) = resolver.query(
                uri, arrayOf(MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.RELATIVE_PATH), null, null, null,
            )?.use { if (it.moveToFirst()) (if (it.isNull(0)) null else it.getLong(0)) to it.getString(1) else null }
                ?: throw PhoneError("There is no photo $id.")
            val picture = runCatching { resolver.loadThumbnail(uri, Size(1600, 1600), null) }.getOrNull()
                ?: throw PhoneError("The phone could not load photo $id.")
            val video = resolver.getType(uri)?.startsWith("video/") == true
            PhoneAnswer(
                "${kind(video, path)} taken ${taken?.let(::iso) ?: "at an unknown time"}.",
                listOf(PhoneCamera.jpeg(picture)),
            )
        }
    }

    suspend fun save(phone: Phone): PhoneAnswer {
        val file = phone.file(phone.arguments<SaveArguments>().fileId)
        try {
            val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()).orEmpty()
            val (collection, folder) = when {
                type.startsWith("image/") -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) to
                    Environment.DIRECTORY_PICTURES
                type.startsWith("video/") -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) to
                    Environment.DIRECTORY_MOVIES
                else -> throw PhoneError("${file.name} is not a picture or a video.")
            }
            val resolver = phone.context.contentResolver
            withContext(Dispatchers.IO) {
                val item = resolver.insert(collection, ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
                    put(MediaStore.MediaColumns.MIME_TYPE, type)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, "$folder/Golem")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }) ?: throw PhoneError("The phone did not save ${file.name}.")
                try {
                    resolver.openOutputStream(item)!!.use { output -> file.inputStream().use { it.copyTo(output) } }
                    resolver.update(item, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                } catch (error: Exception) {
                    resolver.delete(item, null, null)
                    throw error
                }
            }
            return PhoneAnswer("Saved ${file.name} to the gallery.")
        } finally {
            file.parentFile?.deleteRecursively()
        }
    }

    private fun kind(video: Boolean, path: String?) = when {
        video -> "video"
        path?.contains("Screenshots", ignoreCase = true) == true -> "screenshot"
        else -> "photo"
    }

    /** The latitude and longitude where a photo was taken, which Android gives only with ACCESS_MEDIA_LOCATION. */
    private fun place(resolver: ContentResolver, uri: Uri): FloatArray? = runCatching {
        resolver.openInputStream(MediaStore.setRequireOriginal(uri))?.use { stream ->
            FloatArray(2).takeIf { ExifInterface(stream).getLatLong(it) }
        }
    }.getOrNull()

    /** Asks for the photos and videos; Android also lets the person choose only some (READ_MEDIA_VISUAL_USER_SELECTED). */
    private suspend fun access(phone: Phone) {
        val some = if (Build.VERSION.SDK_INT >= 34) Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED else null
        val all = listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        if (all.all(phone::granted) || (some != null && phone.granted(some))) return
        val asked = (all + listOfNotNull(some, Manifest.permission.ACCESS_MEDIA_LOCATION)).toTypedArray()
        try {
            phone.allow("Photos and videos", *asked)
        } catch (_: PhoneError) {
            // The person may allow the photos and not their places.
        }
        if (all.none(phone::granted) && (some == null || !phone.granted(some))) {
            throw PhoneError("The person did not allow Golem to use Photos and videos: Settings › Apps › Golem › Permissions.")
        }
    }
}
