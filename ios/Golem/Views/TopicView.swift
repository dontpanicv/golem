import SwiftUI

/// One topic, as a Slack channel: its chats as messages, the newest at the bottom over the composer, and the
/// settled ones folded above them. Sending from the composer starts a new chat. The title capsule holds the
/// topic's menu.
struct TopicView: View {
    let topicID: String
    /// An artifact to open in the panel, as a search result does.
    var artifactID: String?
    /// Focuses the composer, to start a chat.
    var compose = false
    @Binding var showArtifacts: Bool
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var draft = ""
    @State private var files: [URL] = []
    @State private var sending = false
    @State private var settledFolded = true
    @State private var mergeInto: Topic?
    @Environment(\.phoneTabBar) private var tabBar
    @Environment(\.dismiss) private var dismiss

    private var topic: Topic? { session.topics.first { $0.id == topicID } }
    /// The topics this one can merge into: a topic that every member sees merges only into another such topic.
    private var mergeTargets: [Topic] {
        session.topics.filter { $0.id != topicID && (topic?.ownerId != nil || $0.ownerId == nil) }
    }
    private var activeChats: [ChatSummary] {
        (topic?.chats.filter { $0.settledAt == nil } ?? []).sorted { $0.updatedAt < $1.updatedAt }
    }
    private var settledChats: [ChatSummary] {
        (topic?.chats.filter { $0.settledAt != nil } ?? []).sorted { ($0.settledAt ?? 0) > ($1.settledAt ?? 0) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Tokens.Space.xs) {
                if !settledChats.isEmpty {
                    FoldingSection(title: "Settled · \(settledChats.count)", folded: $settledFolded) {
                        ForEach(settledChats) { chatRow($0) }
                    }
                    ListSeparator()
                }
                ForEach(activeChats) { chatRow($0) }
            }
            .padding(.vertical, Tokens.Space.md)
            .animation(.snappy, value: topic?.chats)
        }
        .returnsToEnd()
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .overlay {
            if topic?.chats.isEmpty ?? true { EmptyState(title: "Ask Golem anything") }
        }
        .dismissesKeyboardOnTap()
        .safeAreaBar(edge: .bottom) {
            ComposerRow {
                Composer(
                    owner: topicID, placeholder: "Message #\(topic?.name ?? "")", draft: $draft, files: $files,
                    sending: sending, autofocus: compose, send: send
                )
            }
        }
        .mobileBackground()
        .inspector(isPresented: $showArtifacts) {
            ArtifactsPanel(
                topicID: topicID, changes: 0, artifactID: artifactID,
                close: tabBar == nil ? nil : { showArtifacts = false }
            )
                .inspectorColumnWidth(Tokens.Size.artifacts)
        }
        // After the inspector: in a navigation stack, a title and toolbar set before it do not show.
        .pushedScreen(topic.map { "#\($0.name)" } ?? "")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button("Files and artifacts", pixel: .panel) { showArtifacts = true }
                    Button("Topic details", pixel: .info) { open(.topicDetails(topicID)) }
                    if !mergeTargets.isEmpty {
                        Divider()
                        Menu("Merge into", pixel: .merge) {
                            ForEach(mergeTargets) { target in
                                Button("# \(target.name)") { mergeInto = target }
                            }
                        }
                    }
                } label: {
                    HeaderTitle(title: "# \(topic?.name ?? "")", caption: chatCount)
                }
                .accessibilityHint("Shows the topic's menu")
            }
        }
        .onAppear { if artifactID != nil { showArtifacts = true } }
        .sheet(item: $mergeInto) { target in
            MergeDialog(
                title: "Merge #\(topic?.name ?? "") into #\(target.name)?",
                message: "Its chats, files, artifacts, and routines move there."
            ) {
                try await session.mergeTopic(topicID: topicID, into: target.id)
                // The merged topic is gone: on iPhone it leaves its tab's stack, and the other topic opens.
                if tabBar != nil { dismiss() }
                open(.topic(target.id))
            }
        }
        .task { await session.run { try await session.reloadWorkspace() } }
    }

    private var chatCount: String {
        activeChats.count == 1 ? "1 open chat" : "\(activeChats.count) open chats"
    }

    /// A chat as Slack shows a message with replies: its title, then a link to it in the accent, or Golem at work.
    private func chatRow(_ chat: ChatSummary) -> some View {
        Button { open(.chat(chat.id)) } label: {
            HStack(alignment: .top, spacing: Tokens.Space.lg) {
                Image(pixel: chat.settledAt == nil ? .chat : .check)
                    .font(.system(size: 15))
                    .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                    .frame(width: Tokens.Mobile.Size.avatar, height: Tokens.Mobile.Size.avatar)
                    .background(Tokens.Mobile.Colors.fill, in: .rect(cornerRadius: Tokens.Radius.lg))
                VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                    Text(chat.title)
                        .font(.golem(Tokens.Mobile.FontSize.body))
                        .foregroundStyle(Tokens.Mobile.Colors.text)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: Tokens.Space.sm) {
                        if session.working.contains(chat.id) {
                            WorkingLabel()
                        } else {
                            Text("View chat")
                                .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium))
                                .foregroundStyle(Tokens.Colors.accent)
                        }
                        Text(Date(milliseconds: chat.updatedAt), format: .relative(presentation: .named))
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
            Button(chat.settledAt == nil ? "Settle chat" : "Un-settle chat",
                   pixel: chat.settledAt == nil ? .check : .inbox) {
                Task {
                    await session.run {
                        try await session.setChatSettled(chatID: chat.id, settled: chat.settledAt == nil)
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
                if let chat = try await session.createChat(topicID: topicID, text: text, files: files) {
                    draft = ""
                    files = []
                    if let workspace = session.workspace {
                        Push.followWork(
                            workspaceID: workspace.id, chatID: chat.id, title: chat.title, api: session.api
                        )
                    }
                    open(.chat(chat.id))
                }
            }
            sending = false
        }
    }
}
