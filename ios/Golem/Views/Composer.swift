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

/// A message box with the files picked, or dropped on it, to send with it, and dictation into it (``MicButton``),
/// as T3's: a glass field with the add button at the start, then the mic and the round send button. While the text
/// fits one line, all sit in one row; else the text spans the field over them. `owner` keys the dictation: the thread,
/// or the channel of a new thread. While `sending`, the send button spins. With `stop`, while the agent works, an empty
/// composer shows Stop in the send button's place, and the send button steers. The Golem thread's composer starts
/// dictating on a ``Dictation`` request.
struct Composer: View {
    let owner: String
    let placeholder: String
    @Binding var draft: String
    @Binding var files: [URL]
    var sending = false
    var autofocus = false
    var stop: (() -> Void)?
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
        let shape = RoundedRectangle(cornerRadius: Tokens.Mobile.Size.voice / 2)
        VStack(alignment: .leading, spacing: 0) {
            if !files.isEmpty {
                FileChips(names: files.map(\.lastPathComponent)) { files.remove(at: $0) }
                    .padding(.horizontal, Tokens.Space.lg)
                    .padding(.top, Tokens.Space.sm)
            }
            ComposerLayout(multiline: !recording && draft.contains("\n"), inset: Tokens.Space.lg) {
                if recording {
                    RecordingBar(
                        startedAt: listener.startedAt, holding: gesture == .hold,
                        level: { active ? listener.level : 0 }, cancel: cancel
                    )
                    .padding(.leading, Tokens.Space.lg)
                    .padding(.trailing, Tokens.Space.md)
                    .frame(minHeight: Tokens.Mobile.Size.voice)
                    .layoutValue(key: ComposerLayout.Fills.self, value: true)
                } else {
                    AttachMenu { files += $0 } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(Tokens.Mobile.Colors.title)
                            .frame(width: Tokens.Mobile.Size.voice, height: Tokens.Mobile.Size.voice)
                            .contentShape(.rect)
                    }
                    .accessibilityLabel("Attach file")
                    field.layoutValue(key: ComposerLayout.Fills.self, value: true)
                }
                MicButton(
                    gesture: $gesture, recording: recording, level: active ? listener.level : 0,
                    start: startListening, cancel: cancel, keep: keep, submit: submit
                )
                .frame(height: Tokens.Mobile.Size.voice)
                sendButton
                    .frame(width: Tokens.Size.listRow, height: Tokens.Mobile.Size.voice)
                    .padding(.trailing, Tokens.Space.xs)
            }
        }
        .glassEffect(.regular.interactive(), in: shape)
        // T3's soft shadow, only outside the field, so that the glass stays clear.
        .background {
            shape.fill(.black).shadow(Tokens.Shadows.composer)
                .mask(Rectangle().inset(by: -Tokens.Space.xxl).subtracting(shape))
        }
        .animation(Tokens.Easing.ease(Tokens.Duration.fast), value: canSend)
        .dropDestination(for: PickedFile.self) { dropped, _ in
            files += dropped.map(\.url)
            return true
        }
        // The field pastes text itself; pictures and files it cannot paste come here.
        .pasteDestination(for: PickedFile.self) { pasted in files += pasted.map(\.url) }
        .sensoryFeedback(.impact, trigger: gesture)
        .onChange(of: active) { _, active in
            if !active, gesture == .locked { gesture = nil }
            // The screen stays on while dictating: a locked phone stops the dictation.
            UIApplication.shared.isIdleTimerDisabled = active
        }
        .onChange(of: Dictation.shared.thread, initial: true) { _, thread in
            guard thread == owner else { return }
            Dictation.shared.thread = nil
            gesture = .locked
            startListening()
        }
        .onDisappear {
            // A conversation keeps the listener when a composer goes away.
            if listener.owner == owner, !VoiceSession.shared.talk.isOn { listener.shutDown() }
            if active { UIApplication.shared.isIdleTimerDisabled = false }
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
                .lineLimit(1...4)
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

    /// Send, or Steer while the agent works; gray while there is nothing to send. Stop takes its place while the agent
    /// works and there is nothing to send.
    @ViewBuilder private var sendButton: some View {
        if let stop, !canSend {
            Button("Stop", systemImage: "stop.fill", action: stop)
                .buttonStyle(.send(Tokens.Mobile.Colors.danger))
        } else {
            Button(action: submit) {
                if sending {
                    ProgressView().controlSize(.mini).tint(Tokens.Colors.onAccent)
                } else {
                    Image(systemName: stop == nil ? "arrow.up" : "arrow.turn.left.up")
                }
            }
            .accessibilityLabel(sending ? "Sending" : stop == nil ? "Send" : "Steer")
            .buttonStyle(.send())
            .disabled(!canSend)
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

/// The composer's row, as T3's: the subview that ``Fills`` takes the room the others leave, while its text fits one
/// line and has no line break. Else it spans the composer, and the others sit in a row under it: those before it at the
/// start, those after it at the end. One layout for both keeps the field, and with it the keyboard's focus.
private struct ComposerLayout: Layout {
    struct Fills: LayoutValueKey { static let defaultValue = false }

    let multiline: Bool
    /// The room at each side of the text that spans the composer.
    let inset: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width }
        return CGSize(width: width, height: frames(width: width, subviews: subviews).map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, frames(width: bounds.width, subviews: subviews)) {
            let origin = CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY)
            subview.place(at: origin, proposal: ProposedViewSize(frame.size))
        }
    }

    private func frames(width: CGFloat, subviews: Subviews) -> [CGRect] {
        let sizes = subviews.map { $0[Fills.self] ? .zero : $0.sizeThatFits(.unspecified) }
        guard let fill = subviews.firstIndex(where: { $0[Fills.self] }) else { return [] }
        let room = max(0, width - sizes.reduce(0) { $0 + $1.width })
        let row = sizes.map(\.height).max() ?? 0
        let inline = subviews[fill].sizeThatFits(ProposedViewSize(width: room, height: nil)).height
        // Without a width, a field has no ideal width; at an endless one it has one line.
        let oneLine = subviews[fill].sizeThatFits(ProposedViewSize(width: .infinity, height: nil)).height
        if !multiline, inline <= oneLine + 1 {
            let height = max(row, inline)
            var x: CGFloat = 0
            return sizes.indices.map { index in
                let size = index == fill ? CGSize(width: room, height: inline) : sizes[index]
                defer { x += size.width }
                return CGRect(x: x, y: height - size.height, width: size.width, height: size.height)
            }
        }
        let text = subviews[fill].sizeThatFits(ProposedViewSize(width: width - 2 * inset, height: nil)).height
        var leading: CGFloat = 0
        var trailing = width - sizes[(fill + 1)...].reduce(0) { $0 + $1.width }
        return sizes.indices.map { index in
            if index == fill { return CGRect(x: inset, y: 0, width: width - 2 * inset, height: text) }
            let size = sizes[index]
            let x = index < fill ? leading : trailing
            if index < fill { leading += size.width } else { trailing += size.width }
            // The row takes half the field's bottom padding, so the buttons sit close under the text.
            return CGRect(x: x, y: text - inset / 2 + row - size.height, width: size.width, height: size.height)
        }
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
