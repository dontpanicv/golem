import AVFoundation
import FluidAudio
import Foundation
import Observation
import os

/// Golem's voice in a conversation (``VoiceChat``): Supertone's Supertonic-3 (BigScience Open RAIL-M), converted to
/// Core ML by FluidInference and run by FluidAudio on the Neural Engine. It says each sentence in Czech or English,
/// whichever the sentence is in (``SpokenLanguage``). It is bundled (ios/scripts/fetch-supertonic.sh, ~170 MB) and
/// loads when a conversation starts.
///
/// Sentences are made one after another as they arrive. Each plays as soon as it is made, in 80 ms buffers, while the
/// next one is being made. In a conversation the audio plays through the listener's engine: echo cancellation needs
/// what the speaker plays on the engine that records.
@Observable
final class Speaker {
    static let shared = Speaker()

    struct Voice: Sendable {
        let id: String
        let name: String
    }

    /// Supertonic-3's voices, offered in Settings. Each speaks both languages.
    static let voices: [Voice] = Supertonic3Voice.allCases.map { voice in
        let number = voice.rawValue.dropFirst()
        return Voice(id: voice.rawValue, name: voice.rawValue.hasPrefix("F") ? "Female \(number)" : "Male \(number)")
    }
    static let key = "golem.voice"

    /// The folder FluidAudio finds the model's folder (`Repo.supertonic3.folderName`) in.
    nonisolated static let directory = Bundle.main.url(forResource: "Supertonic", withExtension: nil)
    nonisolated static var isBundled: Bool { directory != nil }
    nonisolated static let format = AVAudioFormat(
        standardFormatWithSampleRate: Double(Supertonic3Constants.sampleRate), channels: 1)!
    /// Samples in a buffer: 80 ms, so the level follows the voice.
    private static let bufferLength = Supertonic3Constants.sampleRate * 2 / 25

    /// The voice Golem speaks with, chosen in Settings.
    var voice = UserDefaults.standard.string(forKey: key).flatMap { id in voices.first { $0.id == id }?.id }
        ?? Supertonic3Voice.default.rawValue {
        didSet { UserDefaults.standard.set(voice, forKey: Self.key) }
    }
    /// The model is loaded: speech starts at once.
    private(set) var ready = false
    /// What has started playing since the last ``stop()``, to tell Golem's own voice from the user's.
    private(set) var said = ""
    /// The sentence playing now.
    private(set) var current: String?
    /// Output level 0…1 of what plays now.
    private(set) var level: Double = 0
    /// Sentences waiting, being made, or playing.
    var isSpeaking: Bool { !queue.isEmpty || making || played < scheduled }

    /// The node the voice plays on, in the engine it is connected to.
    @ObservationIgnored let player = AVAudioPlayerNode()

    private var queue: [String] = []
    private var making = false
    /// The sentence being made whose audio hasn't been scheduled yet.
    @ObservationIgnored private var unstarted: String?
    private var scheduled = 0
    private var played = 0
    /// The sentence and level of buffers not yet playing, by their number.
    @ObservationIgnored private var starts: [Int: String] = [:]
    @ObservationIgnored private var levels: [Int: Double] = [:]
    /// Counts stops: audio scheduled before one finishes into nothing.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var worker: Task<Void, Never>?
    @ObservationIgnored private var manager: Supertonic3Manager?
    @ObservationIgnored private var loading: Task<Supertonic3Manager, Error>?
    /// The voices loaded so far, by id.
    @ObservationIgnored private var styles: [String: Supertonic3VoiceStyle] = [:]
    /// The language of the last sentence, for one too short to tell.
    @ObservationIgnored private var language = SpokenLanguage.english
    /// An engine of its own, for a sample in Settings outside a conversation.
    @ObservationIgnored private var ownEngine: AVAudioEngine?
    @ObservationIgnored private let log = Logger(subsystem: "dev.golem", category: "speaker")

    // MARK: Model

    /// Loads Supertonic-3 and makes a first sentence, so the Neural Engine is warm for the first real one. A load takes
    /// a moment, except the first after an install, while Core ML prepares the model for this iPhone.
    @discardableResult
    func load() async throws -> Supertonic3Manager {
        if let manager { return manager }
        if let loading { return try await loading.value }
        guard let directory = Self.directory else {
            throw VoiceError("This build of Golem doesn't include Supertonic (run ios/scripts/fetch-supertonic.sh).")
        }
        let voiceStyle = try style(voice)
        let task = Task {
            let started = Date.now
            let manager = Supertonic3Manager(directory: directory)
            try await manager.initialize()
            _ = try await manager.synthesize(text: "Okay.", language: SpokenLanguage.english, style: voiceStyle)
            Logger(subsystem: "dev.golem", category: "speaker")
                .notice("supertonic loaded in \(Date.now.timeIntervalSince(started), format: .fixed(precision: 2)) s")
            return manager
        }
        loading = task
        defer { loading = nil }
        let manager = try await task.value
        self.manager = manager
        ready = true
        return manager
    }

    // MARK: Speaking

    /// Plays through `engine` from now on (the listener's, in a conversation). Call before the engine starts.
    func connect(to engine: AVAudioEngine) {
        if let current = player.engine {
            guard current !== engine else { return }
            current.detach(player)
        }
        if let ownEngine, ownEngine !== engine { ownEngine.stop() }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: Self.format)
    }

    /// Says `sentence` after what is already queued.
    func say(_ sentence: String) {
        queue.append(sentence)
        guard worker == nil else { return }
        worker = Task { [weak self] in
            await self?.work()
            self?.worker = nil
        }
    }

    /// Stops at once: what plays, what is being made and what waits.
    func stop() {
        generation += 1
        worker?.cancel()
        worker = nil
        queue = []
        making = false
        unstarted = nil
        scheduled = 0
        played = 0
        starts = [:]
        levels = [:]
        current = nil
        level = 0
        said = ""
        player.stop()
        if player.engine?.isRunning == true { player.play() }
    }

    /// Stops like ``stop()`` and hands back what wasn't fully said, in order: the sentence playing (from its start) and
    /// the ones after it. For carrying on when the audio has to restart (headphones came or went).
    func halt() -> [String] {
        var rest = [current].compactMap { $0 } + starts.sorted { $0.key < $1.key }.map(\.value)
        if let unstarted { rest.append(unstarted) }
        rest += queue
        stop()
        return rest
    }

    /// Says a sample in `voice`, outside a conversation (Settings).
    func sample(_ voice: String) async throws {
        self.voice = voice
        stop()
        // A model that can't load is an error for the user here, not a silence.
        try await load()
        let engine = ownEngine ?? AVAudioEngine()
        ownEngine = engine
        connect(to: engine)
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try AVAudioSession.sharedInstance().setActive(true)
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        player.play()
        say("Hi, I'm Golem. This is how I'll sound when we talk.")
        say("Ahoj, jsem Golem. Mluvím česky i anglicky.")
    }

    private func work() async {
        let generation = generation
        while !Task.isCancelled, generation == self.generation, !queue.isEmpty {
            let sentence = queue.removeFirst()
            making = true
            unstarted = sentence
            do {
                let manager = try await load()
                let voiceStyle = try style(voice)
                language = SpokenLanguage.of(sentence, after: language)
                let audio = try await manager.synthesize(text: sentence, language: language, style: voiceStyle)
                if !Task.isCancelled, generation == self.generation {
                    for start in stride(from: 0, to: audio.samples.count, by: Self.bufferLength) {
                        let end = min(start + Self.bufferLength, audio.samples.count)
                        schedule(Array(audio.samples[start..<end]), starting: start == 0 ? sentence : nil)
                    }
                    unstarted = nil
                }
            } catch is CancellationError {
            } catch {
                log.error("supertonic failed on \"\(sentence)\": \(error)")
            }
            if generation == self.generation { making = false }
        }
    }

    /// The voice `id`, from the bundle the first time.
    private func style(_ id: String) throws -> Supertonic3VoiceStyle {
        if let style = styles[id] { return style }
        guard let directory = Self.directory, let voice = Supertonic3Voice(name: id) else {
            throw VoiceError("Golem has no voice named \(id).")
        }
        let style = try Supertonic3VoiceStyle.load(
            from: directory.appending(path: Repo.supertonic3.folderName).appending(path: voice.fileName))
        styles[id] = style
        return style
    }

    private func schedule(_ samples: [Float], starting sentence: String?) {
        guard player.engine != nil, !samples.isEmpty,
            let buffer = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: AVAudioFrameCount(samples.count)),
            let channel = buffer.floatChannelData?[0]
        else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        var sum: Float = 0
        for (index, sample) in samples.enumerated() {
            channel[index] = sample
            sum += sample * sample
        }
        let rms = min(1, Double((sum / Float(samples.count)).squareRoot()) * 6)
        let number = scheduled
        if played == scheduled {
            // Nothing is playing: this starts now.
            if let sentence { begin(sentence) }
            level = rms
        } else {
            if let sentence { starts[number] = sentence }
            levels[number] = rms
        }
        scheduled += 1
        let generation = generation
        let played = AudioTap.played { [weak self] in
            Task { @MainActor in self?.finished(number, generation: generation) }
        }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack, completionHandler: played)
        if !player.isPlaying, player.engine?.isRunning == true { player.play() }
    }

    /// Buffer `number` has played: the next one starts.
    private func finished(_ number: Int, generation: Int) {
        guard generation == self.generation else { return }
        played = number + 1
        if let sentence = starts.removeValue(forKey: played) { begin(sentence) }
        level = levels.removeValue(forKey: played) ?? 0
        if played == scheduled, queue.isEmpty, !making { current = nil }
    }

    private func begin(_ sentence: String) {
        current = sentence
        // The last few sentences are enough to recognize an echo.
        said = String((said.isEmpty ? sentence : said + " " + sentence).suffix(400))
    }
}
