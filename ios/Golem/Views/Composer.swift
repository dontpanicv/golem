import PhotosUI
import SwiftUI

/// The bottom of a screen with a composer, as Slack's: on iPhone the composer sits over the tab bar, and over the
/// keyboard while it shows. Without the phone tab bar (iPad) only the composer shows.
struct ComposerRow<Content: View>: View {
    @ViewBuilder let content: Content
    @Environment(\.phoneTabBar) private var tabBar

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .bottom, spacing: Tokens.Space.md) { content }
                .padding(.horizontal, tabBar == nil ? Tokens.Space.lg : Tokens.Mobile.Size.margin)
                .padding(.bottom, bottomPadding)
            if let tabBar, !tabBar.keyboard { Color.clear.frame(height: PhoneTabBar.room) }
        }
    }

    /// On iPhone 8 pt over the keyboard, else none, as the bar's room holds the gap.
    private var bottomPadding: CGFloat {
        guard let tabBar else { return Tokens.Space.xs }
        return tabBar.keyboard ? Tokens.Space.md : 0
    }
}

extension View {
    /// The screen above a composer: a tap on it, as a swipe down, puts the keyboard away, and with it the tab bar comes
    /// back. Taps on its messages and links still work.
    func dismissesKeyboardOnTap() -> some View {
        simultaneousGesture(TapGesture().onEnded {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        })
    }
}

/// File chips in a row that scrolls sideways. Tapping a chip calls `open` with its index; `remove` gives each chip a
/// remove button.
struct FileChips: View {
    let names: [String]
    var open: ((Int) -> Void)?
    var remove: ((Int) -> Void)?

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: Tokens.Space.xs) {
                ForEach(Array(names.enumerated()), id: \.offset) { index, name in
                    if let open {
                        Button { open(index) } label: { FileChip(name: name) }
                            .buttonStyle(.plain)
                    } else {
                        FileChip(name: name, remove: remove.map { remove in { remove(index) } })
                    }
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}

/// A message box with the files picked, or dropped on it, to send with it, and dictation into it (``MicButton``):
/// a glass field as Linear's comment field, with the add button at the start, the mic at the end, and the send
/// button once there is something to send. `owner` keys the dictation: the thread, or the channel of a new thread.
/// While `sending`, the send button spins.
struct Composer: View {
    let owner: String
    let placeholder: String
    @Binding var draft: String
    @Binding var files: [URL]
    var sending = false
    var autofocus = false
    let send: () -> Void
    @Environment(Session.self) private var session
    @State private var gesture: MicButton.Gesture?
    @FocusState private var focused: Bool

    private var listener: Listener { VoiceSession.shared.listener }
    /// The listener listens for this composer.
    private var active: Bool {
        listener.owner == owner && (listener.state == .on || listener.state == .preparing)
    }
    /// Feedback from the first touch, before the microphone has started.
    private var recording: Bool { active || gesture != nil }
    private var canSend: Bool { !draft.isEmpty || !files.isEmpty || active }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !files.isEmpty {
                FileChips(names: files.map(\.lastPathComponent)) { files.remove(at: $0) }
                    .padding(.horizontal, Tokens.Space.lg)
                    .padding(.top, Tokens.Space.sm)
            }
            HStack(alignment: .bottom, spacing: 0) {
                if recording {
                    RecordingBar(
                        startedAt: listener.startedAt, holding: gesture == .hold,
                        level: { active ? listener.level : 0 }, cancel: cancel
                    )
                    .padding(.leading, Tokens.Space.lg)
                    .padding(.trailing, Tokens.Space.md)
                    .frame(minHeight: Tokens.Mobile.Size.voice)
                } else {
                    AttachMenu { files += $0 } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(Tokens.Mobile.Colors.title)
                            .frame(width: Tokens.Mobile.Size.voice, height: Tokens.Mobile.Size.voice)
                            .contentShape(.rect)
                    }
                    .accessibilityLabel("Attach file")
                    field
                }
                MicButton(
                    gesture: $gesture, recording: recording, level: active ? listener.level : 0,
                    start: startListening, cancel: cancel, keep: keep, submit: submit
                )
                .frame(height: Tokens.Mobile.Size.voice)
                if canSend {
                    Button(action: submit) {
                        if sending {
                            ProgressView().controlSize(.mini).tint(Tokens.Colors.onAccent)
                        } else {
                            Label("Send", systemImage: "arrow.up").labelStyle(.iconOnly)
                        }
                    }
                    .accessibilityLabel(sending ? "Sending" : "Send")
                    .buttonStyle(.send)
                    .frame(width: Tokens.Size.listRow, height: Tokens.Mobile.Size.voice)
                    .padding(.trailing, Tokens.Space.xs)
                }
            }
        }
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: Tokens.Mobile.Size.voice / 2))
        .animation(Tokens.Easing.ease(Tokens.Duration.fast), value: canSend)
        .dropDestination(for: PickedFile.self) { dropped, _ in
            files += dropped.map(\.url)
            return true
        }
        .sensoryFeedback(.impact, trigger: gesture)
        .onChange(of: active) { _, active in
            if !active, gesture == .locked { gesture = nil }
        }
        .onDisappear {
            // A conversation keeps the listener when a composer goes away.
            if listener.owner == owner, !VoiceSession.shared.talk.isOn { listener.shutDown() }
        }
    }

    /// The draft, or while listening the words as they are heard; a tap on them stops and keeps them to edit.
    @ViewBuilder private var field: some View {
        Group {
            if active {
                let words = [listener.prefix, listener.text].filter { !$0.isEmpty }.joined(separator: " ")
                Text(words.isEmpty ? "Listening…" : words)
                    .foregroundStyle(words.isEmpty ? Tokens.Mobile.Colors.placeholder : Tokens.Mobile.Colors.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                    .onTapGesture(perform: keep)
            } else {
                TextField(
                    "", text: $draft,
                    prompt: Text(placeholder).foregroundStyle(Tokens.Mobile.Colors.placeholder), axis: .vertical
                )
                .foregroundStyle(Tokens.Mobile.Colors.text)
                .lineLimit(1...8)
                .tint(Tokens.Colors.accent)
                .focused($focused)
                .onAppear { if autofocus { focused = true } }
                .onSubmit(send)
                .accessibilityLabel(placeholder)
            }
        }
        .font(.golem(Tokens.Mobile.FontSize.body))
        .padding(.vertical, 14)
    }

    /// Listens after the typed draft; a conversation in progress ends.
    private func startListening() {
        VoiceSession.shared.talk.end()
        Task {
            await listener.start(owner, prefix: draft.trimmingCharacters(in: .whitespacesAndNewlines))
            if case .failed(let message) = listener.state {
                gesture = nil
                session.show(message, .error)
            }
        }
    }

    /// Stops listening and keeps the words in the field, to edit.
    private func keep() {
        Task {
            let kept = await listener.stop()
            gesture = nil
            // Nothing comes back if it never started: the typed draft stays.
            if !kept.isEmpty { draft = kept }
            focused = true
        }
    }

    /// Sends the draft, or stops listening and sends the words.
    private func submit() {
        guard active else { return send() }
        Task {
            draft = await listener.stop()
            gesture = nil
            send()
        }
    }

    private func cancel() {
        gesture = nil
        listener.cancel()
    }
}

/// A menu that picks files from the photo library or the Files app; `add` gets copies in the temporary folder.
struct AttachMenu<Label: View>: View {
    let add: ([URL]) -> Void
    @ViewBuilder let label: Label
    @State private var pickingFiles = false
    @State private var pickingPhotos = false
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        GolemMenu {
            MenuItem("Photo library", systemImage: "photo.on.rectangle") { pickingPhotos = true }
            MenuItem("Files", systemImage: "folder") { pickingFiles = true }
        } label: {
            label
        }
        .fileImporter(
            isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true
        ) { result in
            add(((try? result.get()) ?? []).compactMap(pickedCopy))
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photos)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            Task {
                var urls: [URL] = []
                for item in items {
                    if let file = try? await item.loadTransferable(type: PickedFile.self) { urls.append(file.url) }
                }
                add(urls)
            }
        }
    }
}

/// A file from the photo library or dropped on Golem, copied to the temporary folder.
struct PickedFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            guard let url = pickedCopy(received.file) else { throw CocoaError(.fileReadUnknown) }
            return PickedFile(url: url)
        }
    }
}

/// A copy of a picked file in the temporary folder: the picked file is readable only while its security scope is open.
nonisolated func pickedCopy(_ url: URL) -> URL? {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let copy = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString)
        .appending(path: url.lastPathComponent)
    do {
        try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: url, to: copy)
        return copy
    } catch {
        return nil
    }
}
