import PhotosUI
import QuickLook
import SwiftUI

/// One thread. Loads its state, then follows the server-sent events until the view disappears.
struct ConversationView: View {
    let threadID: String
    @Binding var showArtifacts: Bool
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var state: ThreadState?
    @State private var failure: String?
    @State private var draft = ""
    @State private var files: [URL] = []
    @State private var preview: URL?

    private var talk: VoiceChat { VoiceSession.shared.talk }

    private var channelName: String {
        session.channels.first { $0.id == state?.thread.channelId }?.name ?? ""
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Tokens.Space.xxl) {
                ForEach(state?.messages ?? []) { MessageRow(message: $0, openFile: openFile) }
            }
            .padding(Tokens.Space.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .overlay {
            if let state {
                if state.messages.isEmpty { EmptyState(title: "Ask Golem anything", systemImage: "sparkles") }
            } else if let failure {
                EmptyState(title: failure, systemImage: "wifi.exclamationmark")
            } else {
                ProgressView()
            }
        }
        .defaultScrollAnchor(.bottom)
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: Tokens.Space.md) {
                if state?.running == true { Badge(label: "Running", tone: .accent) }
                if talk.isOn, talk.thread == threadID {
                    TalkDock(talk: talk)
                } else {
                    Composer(
                        owner: threadID, placeholder: "Message \(channelName)", draft: $draft, files: $files,
                        talk: startTalk, send: send
                    )
                }
            }
            .padding([.horizontal, .bottom], Tokens.Space.lg)
        }
        .background(Tokens.Colors.surface)
        .navigationTitle(state?.thread.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Artifacts", systemImage: "sidebar.right") { showArtifacts.toggle() }
            }
        }
        .inspector(isPresented: $showArtifacts) {
            ArtifactsPanel(threadID: threadID, changes: state?.messages.count ?? 0, openFile: openFile)
                .inspectorColumnWidth(Tokens.Size.artifacts)
        }
        .quickLookPreview($preview)
        .task { await follow() }
        // Thread links in messages open the thread here instead of leaving the app.
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "thread" else { return .systemAction }
            open(.thread(String(url.absoluteString.dropFirst("thread:".count))))
            return .handled
        })
    }

    /// Reloads the thread and reads its events again after each error, with a backoff of 1 to 16 seconds.
    private func follow() async {
        var delay = Duration.seconds(1)
        while !Task.isCancelled {
            do {
                state = try await session.api.thread(threadID)
                failure = nil
                try await session.api.threadEvents(threadID) { next in
                    state = next
                    delay = .seconds(1)
                }
            } catch {
                failure = error.localizedDescription
            }
            try? await Task.sleep(for: delay)
            delay = min(delay * 2, .seconds(16))
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attached = files
        guard !text.isEmpty || !attached.isEmpty else { return }
        draft = ""
        files = []
        Task {
            await session.run {
                do {
                    try await session.api.sendMessage(threadID: threadID, text: text, files: attached)
                } catch {
                    if draft.isEmpty { draft = text }
                    if files.isEmpty { files = attached }
                    throw error
                }
            }
        }
    }

    private func startTalk() {
        Task {
            await talk.start(thread: threadID, api: session.api)
            if !talk.isOn, let error = talk.error { session.show(error, .error) }
        }
    }

    private func openFile(_ file: FileRef) {
        Task {
            await session.run { preview = try await session.api.download(threadID: threadID, file: file) }
        }
    }
}

struct MessageRow: View {
    let message: Message
    let openFile: (FileRef) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.lg) {
            Avatar(name: message.author, agent: message.agent)
            VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.md) {
                    Text(message.author)
                        .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.semibold))
                        .foregroundStyle(Tokens.Colors.text)
                    Text(Date(milliseconds: message.time), format: .dateTime.hour().minute())
                        .font(.golem(Tokens.FontSize.sm))
                        .foregroundStyle(Tokens.Colors.textQuaternary)
                }
                if !message.text.isEmpty {
                    Text(Self.linked(message.text))
                        .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
                        .foregroundStyle(message.failed ? Tokens.Colors.danger : Tokens.Colors.textSecondary)
                        .textSelection(.enabled)
                }
                if !message.files.isEmpty {
                    FileChips(names: message.files.map(\.name)) { openFile(message.files[$0]) }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// The text with each thread link the agent wrote, `[title](thread:<id>)`, as a link to `thread:<id>`.
    static func linked(_ text: String) -> AttributedString {
        var result = AttributedString()
        var rest = text[...]
        while let match = rest.firstMatch(of: /\[([^\]\n]+)\]\(thread:([\w-]+)\)/) {
            result += AttributedString(rest[..<match.range.lowerBound])
            var link = AttributedString(match.1)
            link.link = URL(string: "thread:\(match.2)")
            link.foregroundColor = Tokens.Colors.accent
            result += link
            rest = rest[match.range.upperBound...]
        }
        return result + AttributedString(rest)
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

/// A message box with the files picked, or dropped on it, to send with it, and dictation into it (``MicButton``).
/// `owner` keys the dictation: the thread, or the channel of a new thread. `talk` starts a conversation instead; no
/// button without it.
struct Composer: View {
    let owner: String
    let placeholder: String
    @Binding var draft: String
    @Binding var files: [URL]
    var talk: (() -> Void)?
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

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            if active {
                // The words land in the field as they are heard; a tap stops and keeps them to edit.
                let words = [listener.prefix, listener.text].filter { !$0.isEmpty }.joined(separator: " ")
                Text(words.isEmpty ? "Listening…" : words)
                    .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
                    .foregroundStyle(words.isEmpty ? Tokens.Colors.textQuaternary : Tokens.Colors.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                    .onTapGesture(perform: keep)
            } else {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
                    .lineLimit(1...8)
                    .focused($focused)
                    .onSubmit(send)
            }
            if !files.isEmpty {
                FileChips(names: files.map(\.lastPathComponent)) { files.remove(at: $0) }
            }
            HStack(spacing: Tokens.Space.md) {
                if recording {
                    RecordingBar(startedAt: listener.startedAt, holding: gesture == .hold, cancel: cancel)
                } else {
                    AttachMenu { files += $0 } label: { Label("Attach file", systemImage: "paperclip") }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.ghost)
                }
                Spacer()
                if let talk, !recording {
                    Button("Talk with Golem", systemImage: "waveform", action: talk)
                        .labelStyle(.iconOnly)
                        .buttonStyle(.ghost)
                }
                MicButton(
                    gesture: $gesture, recording: recording, level: active ? listener.level : 0,
                    start: startListening, cancel: cancel, keep: keep, submit: submit
                )
                Button("Send", systemImage: "arrow.up", action: submit)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.send)
                    .disabled(draft.isEmpty && files.isEmpty && !active)
            }
        }
        .padding(Tokens.Space.lg)
        .raisedCard()
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
