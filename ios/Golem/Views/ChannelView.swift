import QuickLook
import SwiftUI

/// The threads of one channel, with its files and artifacts beside them. Sending from the composer starts a new thread.
struct ChannelView: View {
    let channelID: String
    /// An artifact to open in the panel, as a search result does.
    var artifactID: String?
    /// Focuses the composer, to start a thread.
    var compose = false
    @Binding var showArtifacts: Bool
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var preview: URL?
    @State private var draft = ""
    @State private var files: [URL] = []
    @State private var sending = false
    @State private var showSettled = false
    @State private var confirmDelete = false
    @Environment(\.phoneTabBar) private var tabBar

    private var channel: Channel? { session.channels.first { $0.id == channelID } }
    private var activeThreads: [ThreadSummary] { channel?.threads.filter { $0.settledAt == nil } ?? [] }
    private var settledThreads: [ThreadSummary] {
        (channel?.threads.filter { $0.settledAt != nil } ?? [])
            .sorted { ($0.settledAt ?? 0) > ($1.settledAt ?? 0) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                DetailTitle(title: "# \(channel?.name ?? "")")
                    .padding(.horizontal, Tokens.Mobile.Size.margin)
                    .padding(.vertical, Tokens.Space.md)
                ForEach(activeThreads) { thread in threadRow(thread) }
                if !settledThreads.isEmpty {
                    ListSeparator()
                    Button { showSettled.toggle() } label: {
                        ListRow(title: "Settled", systemImage: "tray") {
                            Text("\(settledThreads.count)")
                                .font(.golem(Tokens.Mobile.FontSize.small))
                                .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                                .rotationEffect(.degrees(showSettled ? 90 : 0))
                        }
                    }
                    .buttonStyle(.plain)
                    if showSettled {
                        ForEach(settledThreads) { thread in threadRow(thread) }
                    }
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { tabBar?.expanded = false }
        }
        .overlay {
            if channel?.threads.isEmpty ?? true { EmptyState(title: "Ask Golem anything", systemImage: "sparkles") }
        }
        .safeAreaBar(edge: .bottom) {
            ComposerRow {
                Composer(
                    owner: channelID, placeholder: "Message \(channel?.name ?? "")", draft: $draft, files: $files,
                    sending: sending, autofocus: compose, send: send
                )
            }
        }
        .mobileBackground()
        .inspector(isPresented: $showArtifacts) {
            ArtifactsPanel(
                channelID: channelID, changes: 0, artifactID: artifactID, openFile: openFile,
                close: tabBar == nil ? nil : { showArtifacts = false }
            )
                .inspectorColumnWidth(Tokens.Size.artifacts)
        }
        // After the inspector: in a navigation stack, a title and toolbar set before it do not show.
        .pushedScreen(channel.map { "#\($0.name)" } ?? "")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Artifacts", systemImage: "sidebar.right") { showArtifacts.toggle() }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu("More", systemImage: "ellipsis") {
                    Button("Channel details", systemImage: "info.circle") { open(.channelDetails(channelID)) }
                    Button("Delete channel", systemImage: "trash", role: .destructive) { confirmDelete = true }
                }
            }
        }
        .quickLookPreview($preview)
        .onAppear { if artifactID != nil { showArtifacts = true } }
        .sheet(isPresented: $confirmDelete) {
            DeleteDialog(
                title: "Delete #\(channel?.name ?? "")?",
                message: "Its threads, files, artifacts, and routines go with it.",
                submit: "Delete channel"
            ) {
                try await session.deleteChannel(channelID: channelID)
                if let orchestrator = session.orchestrator { open(.thread(orchestrator.id)) }
            }
        }
        .task { await session.run { try await session.reloadWorkspace() } }
    }

    private func threadRow(_ thread: ThreadSummary) -> some View {
        Button { open(.thread(thread.id)) } label: {
            ListRow(thread.title, systemImage: "bubble.left", working: session.working.contains(thread.id))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(thread.settledAt == nil ? "Settle thread" : "Un-settle thread",
                   systemImage: thread.settledAt == nil ? "checkmark" : "tray") {
                Task {
                    await session.run {
                        try await session.setThreadSettled(threadID: thread.id, settled: thread.settledAt == nil)
                    }
                }
            }
        }
    }

    private func openFile(_ file: FileRef) {
        guard let workspaceID = session.workspace?.id else { return }
        Task { await session.run { preview = try await session.api.download(workspaceID: workspaceID, file: file) } }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !files.isEmpty, !sending else { return }
        sending = true
        Task {
            await session.run {
                if let thread = try await session.createThread(channelID: channelID, text: text, files: files) {
                    draft = ""
                    files = []
                    open(.thread(thread.id))
                }
            }
            sending = false
        }
    }
}
