import Foundation
import Observation
import os

/// Conversation mode in a thread: the user talks, Golem answers aloud, hands-free, until the user ends it.
///
/// - **Hearing.** The listener stays on with echo cancellation, and transcribes only what Apple's sound classifier
///   calls   speech. A pause after the user's words ends their turn (short after a finished sentence, long after
///   "and…"), and   the words go to the thread as a voice message, which steers a run at work.
/// - **Speaking.** It follows the thread's events and says each new sentence of the agent's text as it streams (a voice
///   message asks the agent to say what it is about to do before it uses tools), in Phonon's voice (``Speaker``).
/// - **Cutting in.** With headphones, the user's words stop the voice at once, and what was left unsaid is dropped.
///   On the iPhone's speaker, echo cancellation leaves enough of Golem's voice for the recognizer to turn into words
///   (garbled, so they can't be told from the user's), so only "stop", "wait" and the like cut in there. A tap on the
///   orb always does. What the microphone heard while Golem spoke, and for a moment after, is never sent.
///
/// Ending it stops the microphone and the voice, never the run.
@Observable
final class VoiceChat {
    enum Phase: String {
        case off, starting, listening, hearing, working, speaking
    }

    /// How the user can cut Golem off while it speaks.
    enum CutIn: String {
        /// Talking (headphones: nothing comes back).
        case words
        /// "Stop", "wait"… (the speaker, with echo cancellation).
        case stop
        /// Only the orb (no echo cancellation).
        case tap
    }

    private(set) var phase: Phase = .off
    /// The thread it talks in.
    private(set) var thread: String?
    /// What the user is saying now.
    private(set) var heard = ""
    /// The microphone is ignored (it stays on for echo cancellation).
    private(set) var muted = false
    private(set) var error: String?

    var isOn: Bool { phase != .off }
    /// The sentence Golem says now.
    var said: String? { speaker.current }
    var voiceReady: Bool { speaker.ready }
    /// Whoever speaks now, 0…1.
    var level: Double { phase == .speaking ? speaker.level : listener.level }

    var cutIn: CutIn {
        // Echo cancellation is on only when the conversation started on the speaker.
        if listener.echoCancelled { return .stop }
        return listener.headphones ? .words : .tap
    }

    private let listener: Listener
    private let speaker = Speaker.shared
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var narration = Narration()
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var narrator: Task<Void, Never>?
    @ObservationIgnored private var sending = false
    /// The thread's run is working, as its events last said.
    @ObservationIgnored private var busy = false
    @ObservationIgnored private var wasSpeaking = false
    /// Until then, what the microphone hears is still Golem's voice: the room's echo and the speaker's latency after
    /// the last sentence played.
    @ObservationIgnored private var echoUntil = Date.distantPast
    /// How long Golem's voice lingers in the microphone after it stops.
    static let echoTail: TimeInterval = 0.7
    @ObservationIgnored private let log = Logger(subsystem: "dev.golem", category: "voice-chat")

    static let owner = "talk"

    init(listener: Listener) {
        self.listener = listener
    }

    // MARK: Control

    /// Starts talking in thread `id`, sending through `api`.
    func start(thread id: String, api: APIClient) async {
        if isOn {
            if id == thread { return }
            end()
        }
        phase = .starting
        error = nil
        heard = ""
        muted = false
        thread = id
        self.api = api
        narration = Narration()
        guard Speaker.isBundled else {
            return fail("This build of Golem doesn't include its voice (run ios/scripts/fetch-phonon.sh).")
        }
        // The voice loads while the microphone starts: the user speaks first anyway.
        Task { [speaker, log] in
            do { try await speaker.load() } catch { log.error("phonon failed to load: \(error)") }
        }
        await listener.start(Self.owner, speaker: speaker)
        if case .failed(let message) = listener.state { return fail(message) }
        guard phase == .starting, listener.state == .on else { return }
        follow(id, api: api)
        phase = .listening
        log.notice("conversation started: cut in by \(self.cutIn.rawValue), \(Listener.route)")
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                self?.step()
            }
        }
    }

    /// Stops listening and speaking, and leaves the thread's run alone.
    func end() {
        guard isOn else { return }
        ticker?.cancel()
        ticker = nil
        narrator?.cancel()
        narrator = nil
        speaker.stop()
        if listener.owner == Self.owner { listener.shutDown() }
        phase = .off
        thread = nil
        heard = ""
        muted = false
    }

    /// The orb: stops Golem speaking, or sends what the user said without waiting for the pause.
    func tap() {
        if speaker.isSpeaking {
            interrupt()
            // What the microphone held was Golem's voice.
            listener.clear()
        } else if !listener.text.isEmpty {
            send()
        }
    }

    func mute(_ muted: Bool) {
        self.muted = muted
        if muted { listener.clear() }
    }

    // MARK: The loop

    /// Every tenth of a second: the user's turn, cutting in, and the phase.
    private func step() {
        guard isOn else { return }
        if case .failed(let message) = listener.state { return fail(message) }
        let speaking = speaker.isSpeaking
        // After this step: cutting in stops the voice, and what follows is the user, not an echo.
        defer { wasSpeaking = speaker.isSpeaking }
        let words = listener.text
        if muted {
            if !words.isEmpty { listener.clear() }
            phase = speaking ? .speaking : busy ? .working : .listening
            return
        }
        if speaking { return stepSpeaking(words) }
        // It just stopped speaking: everything heard while it spoke, and its echo for a moment after, was its own
        // voice. The transcription of it can arrive after the voice ends, so the audio itself is dropped.
        if wasSpeaking {
            listener.clear()
            echoUntil = .now + Self.echoTail
        }
        if Date.now < echoUntil {
            if !words.isEmpty { listener.clear() }
            heard = ""
            phase = busy ? .working : .listening
            return
        }
        heard = words
        if words.isEmpty {
            phase = busy ? .working : .listening
        } else {
            phase = .hearing
            if listener.quiet >= TurnEnd.pause(after: words) { send() }
        }
    }

    /// While Golem speaks: what the microphone hears is its own voice, unless the user cuts in.
    private func stepSpeaking(_ words: String) {
        phase = .speaking
        guard !words.isEmpty else { return }
        let cuts = switch cutIn {
        case .words: !Echo.isEcho(words, of: speaker.said)
        case .stop: Echo.interrupts(words, of: speaker.said)
        case .tap: false
        }
        if cuts {
            log.notice("cut in: \(words, privacy: .private)")
            interrupt()
            if cutIn == .words {
                heard = words
                phase = .hearing
            } else {
                // "Stop" is the whole message; the rest was Golem's echo. The user goes on afresh.
                listener.clear()
                phase = busy ? .working : .listening
            }
        } else if listener.quiet > 0.3 {
            // Golem's own voice, transcribed: dropped at each pause, so it is never sent and each pass stays short.
            listener.clear()
        }
    }

    /// The user's turn, to the thread as a voice message.
    private func send() {
        guard !sending else { return }
        sending = true
        Task {
            await deliver()
            sending = false
        }
    }

    private func deliver() async {
        let text = await listener.take().trimmingCharacters(in: .whitespacesAndNewlines)
        heard = ""
        guard isOn, let thread, let api, !text.isEmpty else { return }
        // Nothing to say ("." from a cough or a breath).
        guard text.contains(where: { $0.isLetter || $0.isNumber }) else { return }
        listener.sent()
        if speaker.isSpeaking { interrupt() }
        do {
            try await api.sendMessage(threadID: thread, text: text, files: [], voice: true)
            error = nil
        } catch {
            log.error("send failed: \(error)")
            self.error = error.localizedDescription
        }
    }

    /// Stops the voice and drops what was left to say.
    private func interrupt() {
        speaker.stop()
        narration.skip()
    }

    private func fail(_ message: String) {
        log.error("conversation failed: \(message) (\(Listener.route))")
        end()
        error = message
    }

    // MARK: The thread

    /// Follows the thread and says what its agent writes from now on. Reads the events again after each error.
    private func follow(_ id: String, api: APIClient) {
        narrator?.cancel()
        narrator = Task { [weak self] in
            var first = true
            while !Task.isCancelled {
                do {
                    try await api.threadEvents(id) { state in
                        guard let self, self.thread == id else { return }
                        self.saw(state, first: first)
                        first = false
                    }
                } catch {
                    self?.log.error("thread events ended: \(error)")
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func saw(_ state: ThreadState, first: Bool) {
        busy = state.running
        let (anchor, pieces) = Self.runText(state.messages)
        if first {
            // What was there before the conversation started isn't read out.
            narration.skip(anchor: anchor, pieces: pieces)
        } else {
            let streaming = state.messages.last?.streaming == true
            for sentence in narration.update(anchor: anchor, pieces: pieces, streaming: streaming) {
                speaker.say(sentence)
            }
        }
    }

    /// The text of the newest run: the person's message it answers, and what the agent said after it, in its work and
    /// its answer, the part being written last.
    static func runText(_ messages: [Message]) -> (anchor: String?, pieces: [String]) {
        let start = messages.lastIndex { !$0.agent }
        let after = start.map { messages[($0 + 1)...] } ?? messages[...]
        let said = after.filter { !$0.failed }.flatMap { message in
            (message.work?.steps ?? []).filter { $0.kind == "text" }.map(\.text) + [message.text]
        }
        return (start.map { messages[$0].id }, said)
    }
}
