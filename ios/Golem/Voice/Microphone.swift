import AVFoundation
import Foundation
import os

/// The audio engine a ``Listener`` hears with: the microphone and its cue tones, and in a conversation Golem's voice
/// (``ConversationAudio``), all in one engine.
final class Microphone {
    /// What the microphone is set up for.
    enum Mode {
        /// A composer: the least processing iOS offers, for the recognizer.
        case dictation
        /// A conversation: Golem's voice plays through the same engine, with echo cancellation on the speaker.
        case conversation(ConversationAudio)
    }

    /// The format the tone is played in.
    nonisolated static let playFormat = AVAudioFormat(standardFormatWithSampleRate: 22_050, channels: 1)!

    /// Gets each buffer the microphone records, as samples in `format`, and its loudness; on the main actor.
    var heard: (_ samples: [Float], _ rms: Double) -> Void = { _, _ in }
    /// The audio stopped and can't start again.
    var failed: (Error) -> Void = { _ in }
    private(set) var mode = Mode.dictation
    /// The conversation's audio, in a conversation.
    var conversation: ConversationAudio? {
        if case .conversation(let audio) = mode { audio } else { nil }
    }

    private nonisolated let format: AVAudioFormat
    private var running = false
    /// A new one for each start, and at each restart for a new route (``restart()``).
    private var engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    nonisolated(unsafe) private var converter: AVAudioConverter?
    private var engineChanges: NSObjectProtocol?
    /// When iOS last stopped the engine and it started again.
    private var resumes: [Date] = []
    private let log = Logger(subsystem: "dev.golem", category: "listener")

    /// Records in `format`.
    init(format: AVAudioFormat) {
        self.format = format
    }

    /// Starts the audio for dictation, or with `speaker` for a conversation: with echo cancellation, and the speaker
    /// plays through the same engine.
    func start(speaker: Speaker?) throws {
        if let speaker {
            mode = .conversation(ConversationAudio(
                speaker: speaker, engine: { [unowned self] in self.engine },
                restart: { [weak self] in self?.restart() ?? false }))
        } else {
            mode = .dictation
        }
        running = true
        try startAudio()
    }

    func stop() {
        running = false
        if let engineChanges { NotificationCenter.default.removeObserver(engineChanges) }
        engineChanges = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        conversation?.stop()
        mode = .dictation
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        // An engine that ran keeps what it learned of the hardware: after a failed start (another app holding the
        // audio, say) every later start failed with -10868. The next start gets a new one.
        engine = AVAudioEngine()
    }

    /// A short, quiet cue: the microphone is on (the default), or the words went to Golem.
    func tone(frequency: Double = 880) {
        guard engine.isRunning, let buffer = AudioTap.tone(frequency: frequency, format: Self.playFormat) else {
            return
        }
        player.scheduleBuffer(buffer)
    }

    private func startAudio() throws {
        let session = AVAudioSession.sharedInstance()
        switch mode {
        case .dictation: try setUpDictation(session)
        case .conversation(let conversation): try conversation.setUp(session)
        }
        if player.engine !== engine {
            player.engine?.detach(player)
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: Self.playFormat)
        }
        conversation?.connect()
        try runEngine()
    }

    /// Starts the engine as the session is set up now. The tap takes the microphone's own format, whatever it is by
    /// now: echo cancellation changes it after the session is set up, and a tap in a stale format throws. The
    /// converter follows the buffers (`captured`).
    private func runEngine() throws {
        let node = engine.inputNode
        node.removeTap(onBus: 0)
        converter = nil
        node.installTap(onBus: 0, bufferSize: 2048, format: nil, block: AudioTap.block { [weak self] buffer in
            self?.captured(buffer)
        })
        engine.prepare()
        try engine.start()
        player.play()
        conversation?.started()
        guard engineChanges == nil else { return }
        engineChanges = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.engineChanged() }
        }
    }

    /// iOS stops the engine when the microphone or output changes format (AirPods' call profile, echo cancellation
    /// settling after a restart), and nothing is heard until it starts again: as it is set up, so this can't loop on
    /// its own setup. Headphones coming or going need a new setup as well (``ConversationAudio``).
    private func engineChanged() {
        guard running, !engine.isRunning else { return }
        resumes = resumes.filter { $0 > .now - 10 } + [.now]
        log.notice("microphone resumed \(self.resumes.count) times (\(ConversationAudio.route))")
        guard resumes.count <= 3 else {
            return failed(VoiceError("The microphone keeps stopping (\(ConversationAudio.route))."))
        }
        do {
            try runEngine()
        } catch {
            failed(error)
        }
    }

    /// No voice processing: it is made for calls and smears speech for a recognizer. AirPods that can record at full
    /// bandwidth are used (never their narrow-band call microphone); otherwise the iPhone's own microphone, with the
    /// least processing iOS offers.
    private func setUpDictation(_ session: AVAudioSession) throws {
        try session.setCategory(
            .playAndRecord, mode: .default,
            options: [.bluetoothHighQualityRecording, .allowBluetoothA2DP, .defaultToSpeaker])
        try session.setActive(true)
        let fullBandwidth = session.currentRoute.inputs.contains {
            $0.bluetoothMicrophoneExtension?.highQualityRecording.isEnabled == true
        }
        if !fullBandwidth { try session.setMode(.measurement) }
    }

    /// Starts the audio again for a conversation's new route (``ConversationAudio``), in a new engine: turning echo
    /// cancellation on in one that already ran left it running but silent both ways. False if it failed.
    private func restart() -> Bool {
        if let engineChanges { NotificationCenter.default.removeObserver(engineChanges) }
        engineChanges = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if engine.inputNode.isVoiceProcessingEnabled { try? engine.inputNode.setVoiceProcessingEnabled(false) }
        engine = AVAudioEngine()
        do {
            try startAudio()
        } catch {
            failed(error)
            return false
        }
        return true
    }

    nonisolated private func captured(_ buffer: AVAudioPCMBuffer) {
        let rms = AudioTap.rms(buffer)
        guard let samples = AudioTap.samples(of: buffer, in: format, converter: &converter) else { return }
        Task { @MainActor in
            guard self.running else { return }
            self.heard(samples, rms)
        }
    }
}
