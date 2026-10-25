import SwiftUI

/// The composer's mic. Dictation works like a voice note, but the words land in the field:
/// - hold and talk; let go to send. Slide left to cancel, slide up to lock it on.
/// - a quick tap also locks it on. While locked: the trash cancels, the mic stops and keeps the words to edit, and send
///   sends. Nothing is sent on a pause.
struct MicButton: View {
    enum Gesture { case hold, locked }

    @Binding var gesture: Gesture?
    let recording: Bool
    let level: Double
    let start: () -> Void
    let cancel: () -> Void
    let keep: () -> Void
    let submit: () -> Void
    @State private var press: Press?

    private struct Press {
        var startedAt = Date.now
        /// The touch stops a dictation that was locked on.
        var stops = false
        /// It locked or cancelled while held: letting go does nothing more.
        var done = false
    }

    private var holding: Bool { gesture == .hold }

    var body: some View {
        Image(systemName: recording && !holding ? "stop.fill" : "mic")
            .font(.system(size: Tokens.FontSize.lg, weight: .medium))
            .foregroundStyle(recording ? Tokens.Colors.onAccent : Tokens.Colors.textSecondary)
            .frame(width: Tokens.Size.controlSmall, height: Tokens.Size.controlSmall)
            .background {
                Circle()
                    .fill(recording ? Tokens.Colors.danger : .clear)
                    .scaleEffect(holding ? 1.4 + level * 0.4 : 1)
                    .animation(Tokens.Easing.out(Tokens.Duration.fast), value: level)
            }
            .overlay(alignment: .top) {
                if holding {
                    Image(systemName: "lock")
                        .font(.system(size: Tokens.FontSize.sm, weight: .medium))
                        .foregroundStyle(Tokens.Colors.textTertiary)
                        .offset(y: -Tokens.Size.listRow)
                }
            }
            .frame(minWidth: Tokens.Size.listRow, minHeight: Tokens.Size.listRow)
            .contentShape(.rect)
            .gesture(DragGesture(minimumDistance: 0).onChanged(moved).onEnded { _ in released() })
            .accessibilityElement()
            .accessibilityLabel(recording ? "Stop listening" : "Dictate")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                if recording { keep() } else { gesture = .locked; start() }
            }
    }

    private func moved(_ value: DragGesture.Value) {
        guard var current = press else {
            if recording {
                press = Press(stops: true)
            } else {
                press = Press()
                gesture = .hold
                start()
            }
            return
        }
        guard !current.stops, !current.done else { return }
        if value.translation.height < -60 {
            current.done = true
            gesture = .locked
        } else if value.translation.width < -80 {
            current.done = true
            cancel()
        }
        press = current
    }

    private func released() {
        defer { press = nil }
        guard let press, !press.done else { return }
        if press.stops { return keep() }
        if Date.now.timeIntervalSince(press.startedAt) < 0.35 { return gesture = .locked }
        gesture = nil
        submit()
    }
}

/// While dictating: the trash (once locked on) and the time.
struct RecordingBar: View {
    let startedAt: Date?
    let holding: Bool
    let cancel: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            if holding {
                Image(systemName: "chevron.left")
                    .foregroundStyle(Tokens.Colors.textQuaternary)
                    .accessibilityHidden(true)
            } else {
                Button("Cancel dictation", systemImage: "trash", action: cancel)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.golem(.danger, .icon))
            }
            Circle().fill(Tokens.Colors.danger).frame(width: 8, height: 8)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let seconds = Int(startedAt.map { context.date.timeIntervalSince($0) } ?? 0)
                Text(String(format: "%d:%02d", seconds / 60, seconds % 60))
                    .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium).monospacedDigit())
                    .foregroundStyle(Tokens.Colors.textSecondary)
            }
        }
    }
}

/// Conversation mode in a thread: takes the composer's place while the user talks with Golem. The conversation itself
/// is ``VoiceChat``, so it goes on with the screen locked; this shows it. A tap on the orb stops Golem speaking, or
/// sends what the user said without waiting for the pause.
struct TalkDock: View {
    let talk: VoiceChat

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            HStack(spacing: Tokens.Space.md) {
                Badge(label: phaseLabel, tone: talk.phase == .hearing ? .accent : .neutral)
                if talk.phase == .working || talk.phase == .starting { ProgressView().controlSize(.mini) }
            }
            Text(caption)
                .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
                .foregroundStyle(talk.heard.isEmpty ? Tokens.Colors.textTertiary : Tokens.Colors.text)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let error = talk.error {
                Text(error)
                    .font(.golem(Tokens.FontSize.sm, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Colors.danger)
            }
            HStack(spacing: Tokens.Space.xxl) {
                Spacer()
                Button(talk.muted ? "Unmute" : "Mute", systemImage: talk.muted ? "mic.slash" : "mic") {
                    talk.mute(!talk.muted)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.golem(talk.muted ? .danger : .secondary, .icon))
                Button(action: talk.tap) {
                    Circle()
                        .fill(talk.phase == .speaking ? Tokens.Colors.accent : Tokens.Colors.accentSubtle)
                        .frame(width: 56, height: 56)
                        .scaleEffect(1 + talk.level * 0.3)
                        .animation(Tokens.Easing.out(Tokens.Duration.fast), value: talk.level)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(orbLabel)
                Button("End conversation", systemImage: "xmark", action: talk.end)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.golem(.secondary, .icon))
                Spacer()
            }
        }
        .padding(Tokens.Space.lg)
        .raisedCard()
    }

    private var orbLabel: String {
        if talk.phase == .speaking { return "Stop speaking" }
        return talk.heard.isEmpty ? "Conversation" : "Send now"
    }

    private var phaseLabel: String {
        switch talk.phase {
        case .off, .starting: "Starting"
        case .listening: "Listening"
        case .hearing: "Hearing you"
        case .working: "Working"
        case .speaking: "Golem"
        }
    }

    private var caption: String {
        switch talk.phase {
        case .speaking: talk.said ?? ""
        case _ where !talk.heard.isEmpty: talk.heard
        case .working: "Working"
        case .starting, .off: talk.voiceReady ? "Starting the microphone…" : "Waking the voice…"
        default: talk.muted ? "Muted" : "Go ahead"
        }
    }
}
