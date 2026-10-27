import AVFoundation
import Foundation
import Observation
import os

/// Dictation in every composer, on the iPhone itself.
///
/// One listener, for one thread's composer at a time, with Parakeet (bundled, Czech or English): the words so far are
/// transcribed again every second and at every pause, so the text arrives in short steps, and the final text is always
/// one pass over everything said. Audio heard before the model has loaded is kept and transcribed once it has.
///
/// Only speech is transcribed: Apple's sound classifier marks it (``SpeechActivity``), and the words start where it
/// first heard speech. Until then nothing is transcribed and only the last few seconds of audio are kept.
///
/// The user starts and stops it; nothing is sent on a pause. The composer holds the mic (release sends) or taps it
/// (tap again, or send). `stop()` hands back the words and the composer sends them like typed text. It carries on with
/// the screen locked (the app has background audio).
///
/// In a conversation (``VoiceChat``) it plays Golem's voice through the same engine (``ConversationAudio``), and
/// hands over each turn with ``take()`` while it goes on listening.
@Observable
final class Listener {
    enum State: Equatable {
        case off, preparing, on
        case failed(String)
    }

    private(set) var state: State = .off
    /// Whose composer is listening: a thread id, or a channel id for a new thread.
    private(set) var owner: String?
    /// What the user has said.
    private(set) var text = ""
    /// Typed text the words go after.
    private(set) var prefix = ""
    /// Microphone level 0…1.
    private(set) var level: Double = 0
    /// When listening started, for the timer.
    private(set) var startedAt: Date?
    private(set) var lastError: String?

    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var speech = SpeechActivity()
    @ObservationIgnored nonisolated(unsafe) private var classifier: SpeechClassifier?
    /// Audio time where the words start: earlier results were cleared.
    @ObservationIgnored private var turnStart: Double = 0
    /// Counts clears, so a transcription that finishes after its words were cleared is dropped.
    @ObservationIgnored private var turn = 0
    @ObservationIgnored private var framesFed: Int64 = 0
    @ObservationIgnored private let microphone = Microphone(format: Listener.modelFormat)
    @ObservationIgnored private let log = Logger(subsystem: "dev.golem", category: "listener")

    /// The samples from `audioStart` (a frame index) on.
    @ObservationIgnored private var audio: [Float] = []
    @ObservationIgnored private var audioStart: Int64 = 0
    @ObservationIgnored private var refreshing: Task<Void, Never>?
    /// Audio time the shown text covers, and what the last pass took.
    @ObservationIgnored private var refreshedThrough: Double = 0
    @ObservationIgnored private var refreshCost: Double = 0

    /// The format the model takes: 16 kHz mono.
    nonisolated static let modelFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: Parakeet.sampleRate, channels: 1, interleaved: false)!
    nonisolated static let sampleRate = Parakeet.sampleRate
    /// Audio kept before the window where speech was first heard, for a word's soft start.
    static let preRoll = 0.2
    /// Audio kept after the last speech when a turn is handed over, for a word's soft end.
    static let speechTail = 0.3

    /// Audio seconds heard: the clock the words are measured on.
    private var now: Double { Double(framesFed) / Self.sampleRate }
    private var listening: Bool { state == .on }
    /// Seconds since the user last spoke (or since the words were cleared).
    var quiet: Double { now - speech.lastSpeech }
    /// The conversation's audio, in a conversation.
    private var conversation: ConversationAudio? { microphone.conversation }
    /// What Golem says is taken out of what the microphone hears (``ConversationAudio/echoCancelled``).
    var echoCancelled: Bool { conversation?.echoCancelled ?? false }
    /// Headphones are connected (``ConversationAudio/headphones``).
    var headphones: Bool { ConversationAudio.headphones }
    /// The route's ports, for the log.
    static var route: String { ConversationAudio.route }

    init() {
        microphone.heard = { [weak self] samples, rms in self?.heard(samples, rms: rms) }
        microphone.failed = { [weak self] error in self?.fail(error) }
    }

    // MARK: Control

    /// Loads Parakeet when the app starts, so dictation is transcribed at once. A load takes well under a second,
    /// except the first after an install or update, while Core ML prepares it for the Neural Engine.
    static func warm() {
        guard Parakeet.isBundled else { return }
        Task {
            let log = Logger(subsystem: "dev.golem", category: "listener")
            let started = Date.now
            do {
                try await Parakeet.shared.load()
                let seconds = Date.now.timeIntervalSince(started)
                log.notice("parakeet loaded in \(seconds, format: .fixed(precision: 2)) s")
            } catch {
                log.error("parakeet failed to load: \(error)")
            }
        }
    }

    /// Listens for `owner`'s composer, after the typed `prefix`. With a `speaker`, for a conversation: with echo
    /// cancellation, and the speaker plays through the same engine.
    func start(_ owner: String, prefix: String = "", speaker: Speaker? = nil) async {
        if self.owner != owner {
            if conversation != nil || speaker != nil { close() }
            self.owner = owner
            clearWords()
        }
        self.prefix = prefix
        lastError = nil
        if state == .on { return }
        startedAt = .now
        await open(speaker: speaker)
        if state == .on { microphone.tone() }
    }

    /// Stops listening and hands back the typed prefix and what was said, to send or to edit.
    @discardableResult
    func stop() async -> String {
        guard state != .off else { return "" }
        let words = await finish()
        let kept = [prefix, words].filter { !$0.isEmpty }.joined(separator: " ")
        prefix = ""
        close()
        return kept
    }

    /// Throws the words away and stops.
    func cancel() {
        clearWords()
        prefix = ""
        close()
    }

    /// Throws away the typed prefix and the words so far, and keeps listening: starting over.
    func clear() {
        clearWords()
        prefix = ""
    }

    /// The words so far, finished, and listening goes on with none: one turn of a conversation.
    func take() async -> String {
        guard listening else { return "" }
        let cut = now
        // The pause that ended the turn is nothing to transcribe.
        let words = await finish(through: min(cut, speech.lastSpeech + Self.speechTail))
        clearWords(from: cut)
        return words
    }

    /// A lower tone: the words went to Golem.
    func sent() {
        microphone.tone(frequency: 587)
    }

    /// The thread's screen went away, or the app was closed.
    func shutDown() {
        close()
        owner = nil
    }

    // MARK: Words

    /// The words start again at `start` (now, unless given).
    private func clearWords(from start: Double? = nil) {
        let start = start ?? now
        text = ""
        turnStart = start
        turn += 1
        refreshedThrough = start
        speech.reset(at: start)
        dropAudio(before: start)
    }

    private func dropAudio(before time: Double) {
        let drop = Int(min(max(0, Int64(time * Self.sampleRate) - audioStart), Int64(audio.count)))
        audio.removeFirst(drop)
        audioStart += Int64(drop)
    }

    /// Everything said (through audio time `cut`, by default all of it), finalized; nothing without speech.
    private func finish(through cut: Double? = nil) async -> String {
        guard listening else { return text }
        guard speech.heard else { return "" }
        let cut = cut ?? now
        let turn = turn
        // The shown text already covers it all unless the user was still talking.
        if refreshedThrough < speech.lastSpeech + 0.2 {
            do {
                text = try await Parakeet.shared.transcribe(samples(through: cut))
            } catch {
                lastError = error.localizedDescription
            }
        }
        // Cleared while it finished.
        return self.turn == turn ? text : ""
    }

    /// Every tenth of a second: Parakeet's passes.
    private func tick() {
        guard listening else { return }
        refreshIfDue()
    }

    // MARK: Passes

    /// This turn's samples from where speech starts, up to audio time `end`.
    private func samples(through end: Double) -> [Float] {
        let start = max(turnStart, (speech.onset ?? turnStart) - Self.preRoll)
        let from = Int(max(0, Int64(start * Self.sampleRate) - audioStart))
        let upTo = Int(min(max(0, Int64(end * Self.sampleRate) - audioStart), Int64(audio.count)))
        return from < upTo ? Array(audio[from..<upTo]) : []
    }

    /// Parakeet has no live results: the turn so far is transcribed again every second or so while the user
    /// speaks, and as soon as they pause, so the text is current before a pause ends the turn.
    private func refreshIfDue() {
        guard refreshing == nil, speech.heard else { return }
        let spoke = speech.lastSpeech > refreshedThrough
        let paused = spoke && now - speech.lastSpeech >= 0.3
        // Long turns take longer to transcribe again: don't run back to back.
        let due = now - refreshedThrough >= max(1.0, refreshCost * 3)
        guard paused || (due && spoke) else { return }
        let through = now
        let turn = turn
        let samples = samples(through: through)
        refreshing = Task { [weak self] in
            let started = Date.now
            let words: String?
            do {
                words = try await Parakeet.shared.transcribe(samples)
            } catch {
                self?.log.error("parakeet: \(error)")
                words = nil
            }
            guard let self else { return }
            self.refreshing = nil
            guard self.turn == turn, self.listening else { return }
            self.refreshCost = Date.now.timeIntervalSince(started)
            self.refreshedThrough = through
            if let words { self.text = words }
        }
    }

    // MARK: Audio

    private func open(speaker: Speaker?) async {
        state = .preparing
        do {
            guard Parakeet.isBundled else {
                throw VoiceError(
                    "This build of Golem doesn't include Parakeet (run ios/scripts/fetch-parakeet.sh).")
            }
            guard await AVAudioApplication.requestRecordPermission() else {
                throw VoiceError("Golem needs the microphone. Allow it in Settings → Golem.")
            }
            framesFed = 0
            audio = []
            audioStart = 0
            refreshCost = 0
            // On the same clock as the words: it is fed what they are, from the first frame.
            classifier = try SpeechClassifier(format: Self.modelFormat) { [weak self] confidence, time in
                Task { @MainActor in self?.speech.score(confidence, at: time) }
            }
            try microphone.start(speaker: speaker)
            clearWords()
            // Stopped or cancelled while it started: don't leave the microphone on.
            guard state == .preparing else { return teardown() }
            state = .on
            ticker = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(100))
                    self?.tick()
                }
            }
        } catch {
            fail(error)
        }
    }

    private func fail(_ error: Error) {
        log.error("listener failed: \(error) (\(Self.route))")
        state = .failed(error.localizedDescription)
        teardown()
    }

    private func close() {
        guard state != .off else { return }
        teardown()
        state = .off
        level = 0
        startedAt = nil
    }

    private func teardown() {
        ticker?.cancel()
        ticker = nil
        refreshing?.cancel()
        refreshing = nil
        microphone.stop()
        classifier?.stop()
        classifier = nil
        audio = []
    }

    private func heard(_ samples: [Float], rms: Double) {
        guard listening || state == .preparing else { return }
        audio += samples
        classifier?.analyze(samples)
        framesFed += Int64(samples.count)
        // Dictation records with no gain (measurement mode), so speech is quiet: a meter in decibels, -50…-15 dBFS.
        let decibels = 20 * log10(max(rms, 1e-5))
        level = level * 0.6 + min(1, max(0, (decibels + 50) / 35)) * 0.4
        // Before speech, only what the classifier's first window and the pre-roll can reach back to is needed.
        if !speech.heard, Double(audio.count) / Self.sampleRate > 4 { dropAudio(before: now - 2) }
    }
}
