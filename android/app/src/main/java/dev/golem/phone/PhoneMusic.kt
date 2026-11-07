package dev.golem.phone

import android.app.SearchManager
import android.content.Intent
import android.media.AudioManager
import android.provider.MediaStore
import android.view.KeyEvent
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable

/**
 * Music in the person's music app: Android's play-from-search asks the app that plays music, such as YouTube Music or
 * Spotify, to find and play it; the media keys control what plays. Android tells other apps only whether music plays,
 * not what.
 */
object PhoneMusic {
    @Serializable
    private data class PlayArguments(val query: String, val kind: String? = null)

    @Serializable
    private data class ControlArguments(val action: String)

    @Serializable
    private data class Status(val playing: Boolean, val title: String? = null, val artist: String? = null)

    suspend fun play(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<PlayArguments>()
        val (focus, extra) = when (arguments.kind ?: "song") {
            "album" -> MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE to MediaStore.EXTRA_MEDIA_ALBUM
            "playlist" -> MediaStore.Audio.Playlists.ENTRY_CONTENT_TYPE to MediaStore.EXTRA_MEDIA_PLAYLIST
            "artist" -> MediaStore.Audio.Artists.ENTRY_CONTENT_TYPE to MediaStore.EXTRA_MEDIA_ARTIST
            else -> "vnd.android.cursor.item/audio" to MediaStore.EXTRA_MEDIA_TITLE
        }
        val intent = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
            .putExtra(SearchManager.QUERY, arguments.query)
            .putExtra(MediaStore.EXTRA_MEDIA_FOCUS, focus)
            .putExtra(extra, arguments.query)
        if (intent.resolveActivity(phone.context.packageManager) == null) throw PhoneError("This phone has no music app that plays from a search.")
        return PhoneAnswer("The music app plays ${arguments.query}.") { phone.activity.startActivity(intent) }
    }

    suspend fun control(phone: Phone): PhoneAnswer {
        val action = phone.arguments<ControlArguments>().action
        val audio = phone.context.getSystemService(AudioManager::class.java)
        val key = when (action) {
            "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
            "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
            "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
            "previous" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            "status" -> null
            else -> throw PhoneError("action must be play, pause, next, previous, or status.")
        }
        if (key != null) {
            audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, key))
            audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, key))
            // The player takes a moment to start or stop.
            delay(700)
        }
        return jsonAnswer(Status(playing = audio.isMusicActive))
    }
}
