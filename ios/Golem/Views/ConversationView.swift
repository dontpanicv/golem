import QuickLook
import SwiftUI

/// One thread. Loads its state, then follows the server-sent events until the view disappears.
struct ConversationView: View {
    let threadID: String
    /// An artifact to open in the panel, as a search result does.
    var artifactID: String?
    @Binding var showArtifacts: Bool
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var state: ThreadState?
    @State private var failure: String?
    @State private var draft = ""
    @State private var files: [URL] = []
    @State private var sending = false
    @State private var preview: URL?
    @Environment(\.phoneTabBar) private var tabBar

    private var talk: VoiceChat { VoiceSession.shared.talk }

    private var channelName: String {
        session.channels.first { $0.id == state?.thread.channelId }?.name ?? ""
    }

    /// The workspace's thread that never ends belongs to no channel and stays open.
    private var isOrchestrator: Bool { threadID == session.orchestrator?.id }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Tokens.Space.xxl) {
                if !isOrchestrator, let thread = state?.thread {
                    DetailTitle(title: thread.title, caption: channelName.isEmpty ? nil : "# \(channelName)")
                        .padding(.horizontal, Tokens.Space.xs)
                }
                ForEach(state?.messages ?? []) { MessageRow(message: $0, openFile: openFile) }
            }
            .padding(.horizontal, Tokens.Space.lg)
            .padding(.vertical, Tokens.Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { tabBar?.expanded = false }
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
        .safeAreaBar(edge: .bottom) {
            bottomBar
        }
        .mobileBackground()
        .inspector(isPresented: $showArtifacts) {
            // The orchestrator belongs to the workspace, so its panel shows the workspace's own files and artifacts.
            Group {
                if isOrchestrator || state != nil {
                    ArtifactsPanel(
                        channelID: isOrchestrator ? nil : state?.thread.channelId,
                        changes: state?.messages.count ?? 0, artifactID: artifactID, openFile: openFile,
                        close: tabBar == nil ? nil : { showArtifacts = false }
                    )
                } else {
                    ProgressView()
                }
            }
                .inspectorColumnWidth(Tokens.Size.artifacts)
        }
        // After the inspector: in a navigation stack, a title and toolbar set before it do not show.
        .modifier(ConversationTitle(isOrchestrator: isOrchestrator, title: state?.thread.title ?? ""))
        .toolbar {
            if !isOrchestrator {
                ToolbarItem(placement: .primaryAction) {
                    Button(state?.thread.settledAt == nil ? "Settle thread" : "Un-settle thread",
                           systemImage: state?.thread.settledAt == nil ? "checkmark" : "tray") {
                        guard let thread = state?.thread else { return }
                        Task {
                            await session.run {
                                try await session.setThreadSettled(threadID: threadID, settled: thread.settledAt == nil)
                                open(.channel(thread.channelId))
                            }
                        }
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button("Artifacts", systemImage: "sidebar.right") { showArtifacts.toggle() }
            }
        }
        .quickLookPreview($preview)
        .onAppear { if artifactID != nil { showArtifacts = true } }
        .task { await follow() }
        // Thread links in messages open the thread here instead of leaving the app.
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "thread" else { return .systemAction }
            open(.thread(String(url.absoluteString.dropFirst("thread:".count))))
            return .handled
        })
    }

    /// The running state above the composer row; a conversation takes the composer's place.
    private var bottomBar: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            if state?.running == true {
                HStack(spacing: Tokens.Space.md) {
                    Badge(label: "Running", tone: .accent)
                    Button("Stop", systemImage: "stop.fill") {
                        Task { await session.run { try await session.api.stopThread(threadID) } }
                    }
                    .buttonStyle(.golem(.secondary, .tiny))
                }
                .composerPadding(bottom: false)
            }
            if talk.isOn, talk.thread == threadID {
                TalkDock(talk: talk).composerPadding()
            } else {
                ComposerRow {
                    Composer(
                        owner: threadID, placeholder: isOrchestrator ? "Message Golem" : "Message \(channelName)",
                        draft: $draft, files: $files, sending: sending, send: send
                    )
                    GlassCircleButton(
                        label: "Talk with Golem", systemImage: "waveform", size: Tokens.Mobile.Size.voice,
                        action: startTalk
                    )
                }
            }
        }
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
        guard !text.isEmpty || !files.isEmpty, !sending else { return }
        sending = true
        Task {
            await session.run {
                try await session.api.sendMessage(threadID: threadID, text: text, files: files)
                draft = ""
                files = []
            }
            sending = false
        }
    }

    private func startTalk() {
        Task {
            await talk.start(thread: threadID, api: session.api)
            if !talk.isOn, let error = talk.error { session.show(error, .error) }
        }
    }

    private func openFile(_ file: FileRef) {
        guard let workspaceID = session.workspace?.id else { return }
        Task { await session.run { preview = try await session.api.download(workspaceID: workspaceID, file: file) } }
    }
}

/// The orchestrator is a tab's first screen, titled Golem; a thread is pushed and shows its title in the content.
private struct ConversationTitle: ViewModifier {
    let isOrchestrator: Bool
    let title: String

    func body(content: Content) -> some View {
        if isOrchestrator { content.screenTitle("Golem") } else { content.pushedScreen(title) }
    }
}
