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

    private var channelName: String {
        session.channels.first { $0.id == state?.thread.channelId }?.name ?? ""
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Tokens.Space.xxl) {
                ForEach(state?.messages ?? []) { MessageRow(message: $0) }
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
                Composer(placeholder: "Message \(channelName)", draft: $draft, send: send)
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
            ArtifactsPanel()
                .inspectorColumnWidth(Tokens.Size.artifacts)
        }
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
        guard !text.isEmpty else { return }
        draft = ""
        Task {
            await session.run {
                do {
                    try await session.api.sendMessage(threadID: threadID, text: text)
                } catch {
                    if draft.isEmpty { draft = text }
                    throw error
                }
            }
        }
    }
}

struct MessageRow: View {
    let message: Message

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
                Text(Self.linked(message.text))
                    .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
                    .foregroundStyle(message.failed ? Tokens.Colors.danger : Tokens.Colors.textSecondary)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
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

struct Composer: View {
    let placeholder: String
    @Binding var draft: String
    let send: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
                .lineLimit(1...8)
                .onSubmit(send)
            HStack {
                Button("Attach file", systemImage: "paperclip") {}
                    .labelStyle(.iconOnly)
                    .buttonStyle(.ghost)
                Spacer()
                Button("Send", systemImage: "arrow.up", action: send)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.send)
                    .disabled(draft.isEmpty)
            }
        }
        .padding(Tokens.Space.lg)
        .raisedCard()
    }
}
