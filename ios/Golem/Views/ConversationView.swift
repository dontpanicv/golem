import QuickLook
import SwiftUI

/// One thread, as a Slack thread: messages with their author's avatar, the live status over the composer, and the
/// title capsule with the thread's menu. Loads its state, then follows the server-sent events until the view
/// disappears.
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
    /// The routines and reminders Golem suggests to the person, in their orchestrator only.
    @State private var suggestions: [Suggestion] = []
    @Environment(\.phoneTabBar) private var tabBar
    @Environment(\.scenePhase) private var scenePhase

    private var talk: VoiceChat { VoiceSession.shared.talk }

    private var channelName: String {
        session.channels.first { $0.id == state?.thread.channelId }?.name ?? ""
    }

    /// The workspace's thread that never ends belongs to no channel and stays open.
    private var isOrchestrator: Bool { threadID == session.orchestrator?.id }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                let messages = state?.messages ?? []
                ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                    let continued = index > 0 && MessageRow.continues(message, after: messages[index - 1])
                    MessageRow(
                        message: message, continued: continued,
                        waiting: message.id == working?.id && !approvals.isEmpty, openFile: openFile
                    )
                        .padding(.top, continued ? Tokens.Space.xs : Tokens.Space.lg)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.bottom, Tokens.Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(.snappy, value: state?.messages.count)
        }
        .scrollDismissesKeyboard(.interactively)
        .overlay {
            if let state {
                if state.messages.isEmpty { EmptyState(title: "Ask Golem anything", systemImage: "sparkles") }
            } else if let failure {
                EmptyState(title: failure, systemImage: "wifi.exclamationmark")
            } else {
                ProgressView()
            }
        }
        .dismissesKeyboardOnTap()
        .defaultScrollAnchor(.bottom)
        // New words and messages keep the newest in view.
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
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
        .pushedScreen(isOrchestrator ? "Golem" : state?.thread.title ?? "")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button("Files and artifacts", systemImage: "sidebar.right") { showArtifacts = true }
                    if !isOrchestrator, let thread = state?.thread {
                        Button("Open #\(channelName)", systemImage: "number") { open(.channel(thread.channelId)) }
                        Button(thread.settledAt == nil ? "Settle thread" : "Un-settle thread",
                               systemImage: thread.settledAt == nil ? "checkmark" : "tray") {
                            Task {
                                await session.run {
                                    try await session.setThreadSettled(
                                        threadID: threadID, settled: thread.settledAt == nil
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
                            title: state?.thread.title ?? "", caption: channelName.isEmpty ? nil : "# \(channelName)"
                        )
                    }
                }
                .accessibilityHint("Shows the thread's menu")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Talk with Golem", systemImage: "waveform", action: startTalk)
                    .disabled(talk.isOn && talk.thread == threadID)
            }
        }
        .quickLookPreview($preview)
        .onAppear { if artifactID != nil { showArtifacts = true } }
        // In the background the stream closes, so Golem sends this thread's notifications as pushes.
        .task(id: scenePhase == .background) {
            if scenePhase != .background { await follow() }
        }
        // Golem suggests from quiet threads, so the orchestrator looks again when its own work ends.
        .task(id: state?.running) {
            guard isOrchestrator, state?.running != true, let workspace = session.workspace else { return }
            if let upcoming = try? await session.api.upcoming(workspaceID: workspace.id) {
                suggestions = upcoming.suggestions
            }
        }
        // Thread links in messages open the thread here instead of leaving the app.
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "thread" else { return .systemAction }
            open(.thread(String(url.absoluteString.dropFirst("thread:".count))))
            return .handled
        })
    }

    /// What the agent waits for this person to allow.
    private var approvals: [Approval] {
        (state?.approvals ?? []).filter { $0.approverId == nil || $0.approverId == session.user?.id }
    }

    /// The answer that the agent writes now.
    private var working: Message? {
        state?.messages.last { $0.streaming || ($0.work != nil && $0.work?.endedAt == nil) }
    }

    /// The suggestions and the live status over the composer; a conversation takes the composer's place.
    private var bottomBar: some View {
        ComposerRow {
            VStack(alignment: .leading, spacing: Tokens.Space.sm) {
                ForEach(suggestions) { suggestion in
                    SuggestionCard(suggestion: suggestion) { suggestions.removeAll { $0.id == suggestion.id } }
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                if state?.running == true || !approvals.isEmpty {
                    LiveStatus(
                        work: working?.work, running: state?.running == true, approvals: approvals, threadID: threadID
                    ) {
                        Task { await session.run { try await session.api.stopThread(threadID) } }
                    }
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                if talk.isOn, talk.thread == threadID {
                    TalkDock(talk: talk).transition(.opacity.combined(with: .scale(scale: 0.95)))
                } else {
                    Composer(
                        owner: threadID, placeholder: isOrchestrator ? "Message Golem" : "Reply",
                        draft: $draft, files: $files, sending: sending, send: send
                    )
                }
            }
            .animation(.snappy, value: state?.running)
            .animation(.snappy, value: talk.isOn)
            .animation(.snappy, value: suggestions)
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
                if let workspace = session.workspace {
                    Push.followWork(
                        workspaceID: workspace.id, threadID: threadID,
                        title: isOrchestrator ? "Golem" : state?.thread.title ?? "", api: session.api
                    )
                }
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

/// What the agent does now, over the composer so that it stays in view: Golem's face, the step it is at, and how long
/// it has worked, with Stop; and each action that it waits for this person to allow.
private struct LiveStatus: View {
    let work: Work?
    let running: Bool
    let approvals: [Approval]
    let threadID: String
    let stop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            HStack(spacing: Tokens.Space.md) {
                GolemFace(mood: approvals.isEmpty ? .working : .waiting, size: 28)
                VStack(alignment: .leading, spacing: 0) {
                    Text(step.title)
                        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium))
                        .modifier(Shimmer())
                    if !step.detail.isEmpty {
                        Text(step.detail)
                            .font(.golem(Tokens.Mobile.FontSize.caption))
                            .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if let work {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(WorkLog.duration(context.date.timeIntervalSince(Date(milliseconds: work.startedAt))))
                            .monospacedDigit()
                    }
                    .font(.golem(Tokens.Mobile.FontSize.caption))
                    .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                }
                if running {
                    Button("Stop", systemImage: "stop.fill", action: stop)
                        .buttonStyle(.golem(.secondary, .tiny))
                }
            }
            ForEach(approvals) { approval in
                ApprovalCard(approval: approval, threadID: threadID)
            }
        }
        .padding(Tokens.Space.md)
        .glassEffect(.regular, in: .rect(cornerRadius: Tokens.Mobile.Size.voice / 2))
        .accessibilityElement(children: .contain)
    }

    /// The step the agent is at, as a title and a detail: a tool call, a thought, or the words of its answer.
    private var step: (title: String, detail: String) {
        if !approvals.isEmpty { return ("Waiting for you", "") }
        guard let last = work?.steps.last else { return ("Working", "") }
        switch last.kind {
        // A thread that the call reached shows as its title.
        case "tool": return (WorkLog.toolName(last.tool), String(MessageRow.linked(last.text).characters))
        case "thinking": return ("Thinking", "")
        default: return ("Writing", "")
        }
    }
}

/// An action the agent waits for the person to allow: once, for the rest of the turn on that machine when it allows
/// that, or not; the gold of the icon's eyes at its side. A long text, such as the body of an email, scrolls.
private struct ApprovalCard: View {
    let approval: Approval
    let threadID: String
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
                Spacer()
                Button("Deny") { answer(false) }
                    .buttonStyle(.golem(.danger, .small))
                if approval.allowsTurn {
                    Button("Allow for this turn") { answer(true, scope: "turn") }
                        .buttonStyle(.golem(.secondary, .small))
                }
                Button("Allow") { answer(true) }
                    .buttonStyle(.golem(.primary, .small))
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
                    threadID: threadID, approvalID: approval.id, allow: allow, scope: scope
                )
            }
            busy = false
        }
    }
}
