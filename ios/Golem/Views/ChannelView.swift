import QuickLook
import SwiftUI

/// One channel, as a Slack channel: its threads as messages, the newest at the bottom over the composer, and the
/// settled ones folded above them. Sending from the composer starts a new thread. The title capsule holds the
/// channel's menu.
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
    @State private var settledFolded = true
    @State private var confirmDelete = false
    @Environment(\.phoneTabBar) private var tabBar
    @Environment(\.dismiss) private var dismiss

    private var channel: Channel? { session.channels.first { $0.id == channelID } }
    private var activeThreads: [ThreadSummary] {
        (channel?.threads.filter { $0.settledAt == nil } ?? []).sorted { $0.updatedAt < $1.updatedAt }
    }
    private var settledThreads: [ThreadSummary] {
        (channel?.threads.filter { $0.settledAt != nil } ?? []).sorted { ($0.settledAt ?? 0) > ($1.settledAt ?? 0) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Tokens.Space.xs) {
                if !settledThreads.isEmpty {
                    FoldingSection(title: "Settled · \(settledThreads.count)", folded: $settledFolded) {
                        ForEach(settledThreads) { threadRow($0) }
                    }
                    ListSeparator()
                }
                ForEach(activeThreads) { threadRow($0) }
            }
            .padding(.vertical, Tokens.Space.md)
            .animation(.snappy, value: channel?.threads)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .overlay {
            if channel?.threads.isEmpty ?? true { EmptyState(title: "Ask Golem anything", systemImage: "sparkles") }
        }
        .safeAreaBar(edge: .bottom) {
            ComposerRow {
                Composer(
                    owner: channelID, placeholder: "Message #\(channel?.name ?? "")", draft: $draft, files: $files,
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
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button("Files and artifacts", systemImage: "sidebar.right") { showArtifacts = true }
                    Button("Channel details", systemImage: "info.circle") { open(.channelDetails(channelID)) }
                    Divider()
                    Button("Delete channel", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: {
                    HeaderTitle(title: "# \(channel?.name ?? "")", caption: threadCount)
                }
                .accessibilityHint("Shows the channel's menu")
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
                // On iPhone the channel leaves its tab's stack; the split view opens Golem in its place.
                if tabBar != nil {
                    dismiss()
                } else if let orchestrator = session.orchestrator {
                    open(.thread(orchestrator.id))
                }
            }
        }
        .task { await session.run { try await session.reloadWorkspace() } }
    }

    private var threadCount: String {
        activeThreads.count == 1 ? "1 open thread" : "\(activeThreads.count) open threads"
    }

    /// A thread as Slack shows a message with replies: its title, then a link to it in the accent, or Golem at work.
    private func threadRow(_ thread: ThreadSummary) -> some View {
        Button { open(.thread(thread.id)) } label: {
            HStack(alignment: .top, spacing: Tokens.Space.lg) {
                Image(systemName: thread.settledAt == nil ? "bubble.left" : "checkmark")
                    .font(.system(size: 15))
                    .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                    .frame(width: Tokens.Mobile.Size.avatar, height: Tokens.Mobile.Size.avatar)
                    .background(Tokens.Mobile.Colors.fill, in: .rect(cornerRadius: Tokens.Radius.lg))
                VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                    Text(thread.title)
                        .font(.golem(Tokens.Mobile.FontSize.body))
                        .foregroundStyle(Tokens.Mobile.Colors.text)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: Tokens.Space.sm) {
                        if session.working.contains(thread.id) {
                            WorkingLabel()
                        } else {
                            Text("View thread")
                                .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium))
                                .foregroundStyle(Tokens.Colors.accent)
                        }
                        Text(Date(milliseconds: thread.updatedAt), format: .relative(presentation: .named))
                            .font(.golem(Tokens.Mobile.FontSize.small))
                            .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.vertical, Tokens.Space.md)
            .contentShape(.rect)
        }
        .buttonStyle(.row)
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
        .transition(.opacity.combined(with: .move(edge: .bottom)))
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
