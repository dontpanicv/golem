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
    @State private var draft = ""
    @State private var files: [URL] = []
    @State private var sending = false
    @State private var settledFolded = true
    @State private var mergeInto: Channel?
    @Environment(\.phoneTabBar) private var tabBar
    @Environment(\.dismiss) private var dismiss

    private var channel: Channel? { session.channels.first { $0.id == channelID } }
    /// The channels this one can merge into: a channel that every member sees merges only into another such channel.
    private var mergeTargets: [Channel] {
        session.channels.filter { $0.id != channelID && (channel?.ownerId != nil || $0.ownerId == nil) }
    }
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
        .returnsToEnd()
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .overlay {
            if channel?.threads.isEmpty ?? true { EmptyState(title: "Ask Golem anything") { GolemGlyph(size: 24) } }
        }
        .dismissesKeyboardOnTap()
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
                channelID: channelID, changes: 0, artifactID: artifactID,
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
                    if !mergeTargets.isEmpty {
                        Divider()
                        Menu("Merge into", systemImage: "arrow.triangle.merge") {
                            ForEach(mergeTargets) { target in
                                Button("# \(target.name)") { mergeInto = target }
                            }
                        }
                    }
                } label: {
                    HeaderTitle(title: "# \(channel?.name ?? "")", caption: threadCount)
                }
                .accessibilityHint("Shows the channel's menu")
            }
        }
        .onAppear { if artifactID != nil { showArtifacts = true } }
        .sheet(item: $mergeInto) { target in
            MergeDialog(
                title: "Merge #\(channel?.name ?? "") into #\(target.name)?",
                message: "Its threads, files, artifacts, and routines move there."
            ) {
                try await session.mergeChannel(channelID: channelID, into: target.id)
                // The merged channel is gone: on iPhone it leaves its tab's stack, and the other channel opens.
                if tabBar != nil { dismiss() }
                open(.channel(target.id))
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

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !files.isEmpty, !sending else { return }
        sending = true
        Task {
            await session.run {
                if let thread = try await session.createThread(channelID: channelID, text: text, files: files) {
                    draft = ""
                    files = []
                    if let workspace = session.workspace {
                        Push.followWork(
                            workspaceID: workspace.id, threadID: thread.id, title: thread.title, api: session.api
                        )
                    }
                    open(.thread(thread.id))
                }
            }
            sending = false
        }
    }
}
