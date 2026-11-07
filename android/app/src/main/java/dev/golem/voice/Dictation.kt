package dev.golem.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CompletableDeferred

/**
 * Dictation into a composer with Android's own speech recognition: the words show as they are heard, and `stop`
 * gives them all, after the typed draft. One composer listens at a time (`owner`).
 */
class Dictation(private val context: Context) {
    enum class State { Off, Listening, Failed }

    var owner by mutableStateOf<String?>(null)
        private set
    var state by mutableStateOf(State.Off)
        private set
    /** The typed draft before the words. */
    var prefix by mutableStateOf("")
        private set
    /** The words heard so far. */
    var text by mutableStateOf("")
        private set
    /** How loud the voice is now, from 0 to 1. */
    var level by mutableFloatStateOf(0f)
        private set
    var startedAt = 0L
        private set
    var error: String? = null
        private set

    private var recognizer: SpeechRecognizer? = null
    /** The words that sessions before this one heard; Android ends a session at each pause. */
    private var heard = ""
    private var ended: CompletableDeferred<Unit>? = null

    val available: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)

    fun start(owner: String, prefix: String) {
        cancel()
        this.owner = owner
        this.prefix = prefix
        heard = ""
        text = ""
        error = null
        startedAt = System.currentTimeMillis()
        state = State.Listening
        listen()
    }

    /** Stops and gives the draft with the words heard. */
    suspend fun stop(): String {
        if (state != State.Listening) return joined()
        val done = CompletableDeferred<Unit>().also { ended = it }
        recognizer?.stopListening()
        // A recognizer that heard nothing may never call back.
        kotlinx.coroutines.withTimeoutOrNull(1500) { done.await() }
        val result = joined()
        finish()
        return result
    }

    fun cancel() {
        recognizer?.cancel()
        finish()
    }

    private fun finish() {
        recognizer?.destroy()
        recognizer = null
        state = State.Off
        owner = null
        level = 0f
        ended?.complete(Unit)
        ended = null
    }

    private fun joined() = listOf(prefix, text).filter { it.isNotBlank() }.joinToString(" ").trim()

    private fun listen() {
        val recognizer = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {
                level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
            }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {
                words(partialResults)?.let { text = listOf(heard, it).filter(String::isNotBlank).joinToString(" ") }
            }
            override fun onResults(results: Bundle?) {
                words(results)?.let { heard = listOf(heard, it).filter(String::isNotBlank).joinToString(" ") }
                text = heard
                ended?.let {
                    it.complete(Unit)
                    return
                }
                // The person still dictates: listen on after the pause.
                if (state == State.Listening) listen()
            }
            override fun onError(code: Int) {
                ended?.let {
                    it.complete(Unit)
                    return
                }
                if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    if (state == State.Listening) listen()
                    return
                }
                error = when (code) {
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Golem needs the microphone to dictate."
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Dictation needs a connection."
                    else -> "Dictation stopped."
                }
                finish()
                state = State.Failed
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        recognizer.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        )
    }

    private fun words(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }
}
