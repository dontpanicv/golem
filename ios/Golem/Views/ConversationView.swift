import SwiftUI

/// One chat, as a Slack thread: messages with their author's avatar, the approvals after them, and
/// the title capsule with the chat's menu. Loads its state, then follows the server-sent events until the view
/// disappears.
struct ConversationView: View {
    let chatID: String
    /// An artifact to open in the panel, as a search result does.
    var artifactID: String?
    @Binding var showArtifacts: Bool
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var state: ChatState?
    @State private var failure: String?
    @State private var draft = ""
    @State private var files: [URL] = []
    @State private var sending = false
    @State private var opening: FileRef?
    /// The artifact of the last `artifact:` link the person tapped.
    @State private var linkedArtifact: String?
    /// The routines and reminders Golem suggests to the person, in their orchestrator only.
    @State private var suggestions: [Suggestion] = []
    /// How many of the newest messages show. Every update measures each row, so showing a whole long chat makes it
    /// stutter while the agent works; older messages join as the person scrolls up.
    @State private var shown = Self.page
    private static let page = 40
    @State private var atStart = false
    @State private var scrollIdle = true
    @State private var position = ScrollPosition()
    @Environment(\.phoneTabBar) private var tabBar
    @Environment(\.youMenu) private var youMenu
    @Environment(\.scenePhase) private var scenePhase

    private var talk: VoiceChat { VoiceSession.shared.talk }

    private var topicName: String {
        session.topics.first { $0.id == state?.chat.topicId }?.name ?? ""
    }

    /// The workspace's chat that never ends belongs to no topic and stays open.
    private var isOrchestrator: Bool { chatID == session.orchestrator?.id }

    var body: some View {
        ScrollView {
            // Not lazy: a lazy stack guesses the height of rows it has not measured, and a tall new row, such as an
            // open work log, made it move the list several screens past the messages.
            VStack(alignment: .leading, spacing: 0) {
                let messages = state?.messages ?? []
                let first = max(0, messages.count - shown)
                if first > 0 {
                    Color.clear.frame(height: 1).onScrollVisibilityChange { visible in
                        atStart = visible
                        showOlder()
                    }
                }
                ForEach(Array(messages.enumerated().dropFirst(first)), id: \.element.id) { index, message in
                    let continued = index > 0 && MessageRow.continues(message, after: messages[index - 1])
                    MessageRow(
                        message: message, continued: continued,
                        waiting: message.id == working?.id && !approvals.isEmpty, openFile: openFile
                    )
                        .equatable()
                        .padding(.top, continued ? Tokens.Space.xs : Tokens.Space.lg)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                // In line with the text of the answer that asks.
                ForEach(approvals) { approval in
                    ApprovalCard(approval: approval, chatID: chatID)
                        .padding(.leading, Tokens.Mobile.Size.avatar + Tokens.Space.lg)
                        .padding(.top, Tokens.Space.md)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.bottom, Tokens.Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(.snappy, value: state?.messages.count)
            .animation(.snappy, value: approvals)
        }
        .scrollDismissesKeyboard(.interactively)
        // Messages dissolve at both ends of the transcript, as on the web.
        .overlay(alignment: .top) { fade(.fadeTop) }
        .overlay(alignment: .bottom) { fade(.fadeBottom) }
        .overlay {
            if let state {
                if state.messages.isEmpty { EmptyState(title: "Ask Golem anything") }
            } else if let failure {
                EmptyState(title: failure)
            } else {
                ProgressView()
            }
        }
        .dismissesKeyboardOnTap()
        .defaultScrollAnchor(.bottom)
        // New words and messages keep the newest in view.
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .returnsToEnd(position: $position) { phase in
            scrollIdle = phase == .idle
            showOlder()
        }
        .safeAreaBar(edge: .bottom) {
            bottomBar
        }
        .mobileBackground()
        .inspector(isPresented: $showArtifacts) {
            // The orchestrator belongs to the workspace, so its panel shows the workspace's own files and artifacts.
            Group {
                if isOrchestrator || state != nil {
                    ArtifactsPanel(
                        topicID: isOrchestrator ? nil : state?.chat.topicId,
                        changes: state?.messages.count ?? 0, artifactID: linkedArtifact ?? artifactID,
                        close: tabBar == nil ? nil : { showArtifacts = false }
                    )
                    .id(linkedArtifact)
                } else {
                    ProgressView()
                }
            }
                .inspectorColumnWidth(Tokens.Size.artifacts)
        }
        // After the inspector: in a navigation stack, a title and toolbar set before it do not show.
        .pushedScreen(isOrchestrator ? "Golem" : state?.chat.title ?? "")
        .toolbar {
            if let youMenu {
                ToolbarItem(placement: .topBarLeading) { YouMenu(open: youMenu) }
                    .sharedBackgroundVisibility(.hidden)
            }
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button("Files and artifacts", pixel: .panel) { showArtifacts = true }
                    if !isOrchestrator, let chat = state?.chat {
                        Button("Open #\(topicName)", pixel: .hash) { open(.topic(chat.topicId)) }
                        Menu("Move to", pixel: .right) {
                            ForEach(session.topics.filter { $0.id != chat.topicId }) { topic in
                                Button(topic.name, pixel: topic.ownerId == nil ? .hash : .lock) {
                                    Task {
                                        await session.run {
                                            try await session.moveChat(chatID: chatID, topicID: topic.id)
                                        }
                                    }
                                }
                            }
                        }
                        Button(chat.settledAt == nil ? "Settle chat" : "Un-settle chat",
                               pixel: chat.settledAt == nil ? .check : .inbox) {
                            Task {
                                await session.run {
                                    try await session.setChatSettled(
                                        chatID: chatID, settled: chat.settledAt == nil
                                    )
                                }
                            }
                        }
                    }
                } label: {
                    if isOrchestrator {
                        HStack(spacing: Tokens.Space.sm) {
                            GolemMark()
                            HeaderTitle(title: "Golem", caption: state?.running == true ? "Working" : nil)
                        }
                        .padding(.leading, Tokens.Space.sm)
                    } else {
                        HeaderTitle(
                            title: state?.chat.title ?? "", caption: topicName.isEmpty ? nil : "# \(topicName)"
                        )
                    }
                }
                .accessibilityHint("Shows the chat's menu")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Talk with Golem", pixel: .sound, action: startTalk)
                    .disabled(talk.isOn && talk.chat == chatID)
            }
        }
        .filePreview($opening)
        .onAppear { if artifactID != nil { showArtifacts = true } }
        // In the background the stream closes, so Golem sends this chat's notifications as pushes.
        .task(id: scenePhase == .background) {
            if scenePhase != .background { await follow() }
        }
        // Golem suggests from quiet chats, so the orchestrator looks again when its own work ends.
        .task(id: state?.running) {
            guard isOrchestrator, state?.running != true, let workspace = session.workspace else { return }
            if let upcoming = try? await session.api.upcoming(workspaceID: workspace.id) {
                suggestions = upcoming.suggestions
            }
        }
        // Golem's links in messages open here instead of leaving the app.
        .environment(\.openURL, OpenURLAction { url in
            guard let scheme = url.scheme, ["chat", "file", "artifact"].contains(scheme) else {
                return .systemAction
            }
            let id = String(url.absoluteString.dropFirst(scheme.count + 1))
            switch scheme {
            case "chat": open(.chat(id))
            // The server names the file when it sends it.
            case "file": openFile(FileRef(id: id, name: ""))
            default:
                linkedArtifact = id
                showArtifacts = true
            }
            return .handled
        })
    }

    /// What the agent waits for this person to allow.
    private var approvals: [Approval] {
        (state?.approvals ?? []).filter { $0.approverId == nil || $0.approverId == session.user?.id }
    }

    /// Adds older messages only at rest: while the list moves, the rows added above it would make it jump.
    private func showOlder() {
        guard atStart, scrollIdle, let messages = state?.messages, shown < messages.count else { return }
        let oldest = messages[messages.count - shown].id
        shown += Self.page
        position.scrollTo(id: oldest, anchor: .top)
    }

    /// The answer that the agent writes now.
    private var working: Message? {
        state?.messages.last { $0.streaming || ($0.work != nil && $0.work?.endedAt == nil) }
    }

    /// The suggestions over the composer; a conversation takes the composer's place.
    private func fade(_ pattern: Dither) -> some View {
        DitherView(pattern: pattern)
            .foregroundStyle(Tokens.Mobile.Colors.background)
            .frame(height: pattern.size.height)
            .allowsHitTesting(false)
    }

    private var bottomBar: some View {
        ComposerRow {
            VStack(alignment: .leading, spacing: Tokens.Space.sm) {
                ForEach(suggestions) { suggestion in
                    SuggestionCard(suggestion: suggestion) { suggestions.removeAll { $0.id == suggestion.id } }
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                if talk.isOn, talk.chat == chatID {
                    TalkDock(talk: talk).transition(.opacity.combined(with: .scale(scale: 0.95)))
                } else {
                    Composer(
                        owner: chatID, placeholder: isOrchestrator ? "Message Golem" : "Reply",
                        draft: $draft, files: $files, sending: sending,
                        stop: state?.running == true ? { stopChat() } : nil, send: send
                    )
                }
            }
            .animation(.snappy, value: state?.running)
            .animation(.snappy, value: talk.isOn)
            .animation(.snappy, value: suggestions)
        }
    }

    /// Reloads the chat and reads its events again after each error, with a backoff of 1 to 16 seconds.
    private func follow() async {
        var delay = Duration.seconds(1)
        while !Task.isCancelled {
            do {
                let loaded = try await session.api.chat(chatID)
                // The first messages show at once, so the list does not measure its rows while they slide in.
                var transaction = Transaction()
                transaction.disablesAnimations = state == nil
                withTransaction(transaction) { state = loaded }
                failure = nil
                var opened = false
                try await session.api.chatEvents(chatID) { next in
                    state = next
                    delay = .seconds(1)
                    // The stream reads the chat's notifications before its first event.
                    if !opened {
                        opened = true
                        Task { try? await session.loadInbox() }
                    }
                }
            } catch {
                failure = error.localizedDescription
            }
            try? await Task.sleep(for: delay)
            delay = min(delay * 2, .seconds(16))
        }
    }
}

extension ConversationView {
    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !files.isEmpty, !sending else { return }
        sending = true
        Task {
            await session.run {
                try await session.api.sendMessage(chatID: chatID, text: text, files: files)
                draft = ""
                files = []
                if let workspace = session.workspace {
                    Push.followWork(
                        workspaceID: workspace.id, chatID: chatID,
                        title: isOrchestrator ? "Golem" : state?.chat.title ?? "", api: session.api
                    )
                }
            }
            sending = false
        }
    }

    private func stopChat() {
        Task { await session.run { try await session.api.stopChat(chatID) } }
    }

    private func startTalk() {
        Task {
            await talk.start(chat: chatID, api: session.api)
            if !talk.isOn, let error = talk.error { session.show(error, .error) }
        }
    }

    private func openFile(_ file: FileRef) { opening = file }
}

/// An action the agent waits for the person to allow: once, for the rest of the turn on that machine when it allows
/// that, or not; `gold` at its side, and the buttons at the start of the line, far from the
/// composer's Send. A long text, such as the body of an email, scrolls.
private struct ApprovalCard: View {
    let approval: Approval
    let chatID: String
    @Environment(Session.self) private var session
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            ViewThatFits(in: .vertical) {
                text
                ScrollView { text }
            }
            .frame(maxHeight: 240)
            HStack(spacing: Tokens.Space.sm) {
                Button("Allow") { answer(true) }
                    .buttonStyle(.golem(.primary, .small))
                if approval.allowsTurn {
                    Button("Allow for this turn") { answer(true, scope: "turn") }
                        .buttonStyle(.golem(.secondary, .small))
                }
                Button("Deny") { answer(false) }
                    .buttonStyle(.golem(.danger, .small))
            }
            .disabled(busy)
        }
        .padding(Tokens.Space.lg)
        .raisedCard(radius: Tokens.Radius.xl, ring: Tokens.Colors.ringControl)
        .overlay(alignment: .leading) {
            Rectangle().fill(Tokens.Colors.gold).frame(width: 3)
        }
        .clipShape(.rect(cornerRadius: Tokens.Radius.xl))
    }

    private var text: some View {
        Text(approval.text)
            .font(.system(size: Tokens.FontSize.md, design: .monospaced))
            .foregroundStyle(Tokens.Colors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func answer(_ allow: Bool, scope: String = "once") {
        busy = true
        Task {
            await session.run {
                try await session.api.answerApproval(
                    chatID: chatID, approvalID: approval.id, allow: allow, scope: scope
                )
            }
            busy = false
        }
    }
}
