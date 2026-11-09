import SwiftUI

/// Login, then the open workspace. Every screen reads the server through `Session`.
struct RootView: View {
    @State private var session = Session()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if !session.signedIn {
                LoginView()
            } else if session.user == nil {
                LoadingView()
            } else if session.workspaces.isEmpty {
                NotMemberView()
            } else {
                MainView()
            }
        }
        .toasts(hidden: session.dialogs > 0)
        .environment(session)
        .tint(Tokens.Colors.accent)
        .task(id: session.signedIn) {
            if session.signedIn { await session.load() }
        }
        .task(id: "\(session.signedIn) \(Push.shared.token ?? "")") { await session.registerDevice() }
        // A tapped Live Activity opens its chat.
        .onOpenURL { url in
            if let tapped = Push.tapped(url) { Push.shared.tapped = tapped }
        }
        .task(id: session.workspace?.id) { await session.watchPlaces() }
        // The agents use the phone's tools while the app is open (PhoneLink).
        .task(id: session.signedIn && scenePhase != .background) {
            if session.signedIn, scenePhase != .background { await PhoneLink.follow(session.api) }
        }
        // Chats read on screen read their notifications, so the inbox and the app icon load again. A reminder or a
        // routine at a place that an agent made while the app was open is watched once the app goes to the background.
        .onChange(of: scenePhase) {
            if scenePhase != .inactive {
                Task {
                    try? await session.loadInbox()
                    await session.watchPlaces()
                }
            }
        }
    }
}

private struct LoadingView: View {
    @Environment(Session.self) private var session

    var body: some View {
        VStack(spacing: Tokens.Space.lg) {
            if let error = session.loadError {
                EmptyState(title: error)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Retry") { Task { await session.load() } }.buttonStyle(.primary)
                Button("Sign out") { Task { await session.signOut() } }.buttonStyle(.ghost)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .mobileBackground()
    }
}

enum Destination: Hashable, Identifiable {
    case search
    case topic(String)
    /// A topic with its composer focused, to start a chat.
    case newChat(String)
    /// A topic with one of its artifacts open, or the orchestrator with one of the workspace's own for a nil topic.
    case artifact(topic: String?, artifact: String)
    case topicDetails(String)
    case chat(String)
    case inbox
    case upcoming
    case following
    case feedback
    case workspaceSettings
    case settings

    var id: Self { self }

    /// What `MainView` remembers, so the app opens on the last topic or chat.
    var key: String? {
        switch self {
        case let .topic(id): "topic:\(id)"
        case let .chat(id): "chat:\(id)"
        default: nil
        }
    }

    /// The topic or chat of a ``key``.
    init?(key: String) {
        let parts = key.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        switch parts[0] {
        case "topic": self = .topic(parts[1])
        case "chat": self = .chat(parts[1])
        default: return nil
        }
    }
}

/// The iPhone shell (``PhoneShell``) or, where there is room, the split view with the sidebar.
private struct MainView: View {
    @Environment(Session.self) private var session
    @Environment(\.horizontalSizeClass) private var sizeClass
    @AppStorage("openedDestination") private var opened = ""
    /// The shell in use. It changes after the size class, once the split view's sheets end: at a compact width, UIKit
    /// makes the split view's open inspector a sheet, which stays on screen, empty, when the shell replaces the split
    /// view.
    @State private var compact: Bool?
    /// What the split view had open, for the iPhone shell after the phone turns back to portrait.
    @State private var resume: Destination?

    var body: some View {
        Group {
            if compact ?? (sizeClass == .compact) { PhoneShell(resume: resume) } else { SplitView() }
        }
        .onChange(of: sizeClass) {
            Task {
                if sizeClass == .compact { await endSheets() }
                resume = Destination(key: opened)
                compact = sizeClass == .compact
            }
        }
        .task(id: session.workspace?.id) { await session.followWorking() }
    }

    /// Waits until the sheet on screen has come in, then closes it.
    private func endSheets() async {
        let root = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?
            .rootViewController
        guard let sheet = root?.presentedViewController else { return }
        if let transition = sheet.transitionCoordinator {
            await withCheckedContinuation { done in
                transition.animate(alongsideTransition: nil) { _ in done.resume() }
            }
        }
        await withCheckedContinuation { done in sheet.dismiss(animated: false) { done.resume() } }
    }
}

/// Topics with their chats on the left, the open screen in the detail column, artifacts in the inspector.
private struct SplitView: View {
    @Environment(Session.self) private var session
    @State private var selection: Destination?
    @State private var column = NavigationSplitViewColumn.sidebar
    @State private var showArtifacts = false
    @AppStorage("openedDestination") private var opened = ""
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            Sidebar(selection: selection, open: open)
                .navigationSplitViewColumnWidth(Tokens.Size.sidebar)
        } detail: {
            // Without the stack, a screen opened from the sidebar on iPhone disappears as it appears: its tasks stop.
            NavigationStack {
                switch selection {
                case .search:
                    SearchView(open: open).id(session.workspace?.id)
                case let .topic(id):
                    TopicView(topicID: id, showArtifacts: $showArtifacts, open: open).id(id)
                case let .newChat(id):
                    TopicView(topicID: id, compose: true, showArtifacts: $showArtifacts, open: open).id(id)
                case let .artifact(topic?, artifact):
                    TopicView(topicID: topic, artifactID: artifact, showArtifacts: $showArtifacts, open: open)
                        .id(artifact)
                case let .artifact(nil, artifact):
                    if let orchestrator = session.orchestrator {
                        ConversationView(
                            chatID: orchestrator.id, artifactID: artifact, showArtifacts: $showArtifacts, open: open
                        )
                            .id(artifact)
                    }
                case let .topicDetails(id):
                    TopicDetailsView(topicID: id, open: open).id(id)
                case let .chat(id):
                    ConversationView(chatID: id, showArtifacts: $showArtifacts, open: open).id(id)
                case .inbox:
                    InboxView(open: open).id(session.workspace?.id)
                case .following:
                    FollowingView(open: open).id(session.workspace?.id)
                case .upcoming:
                    UpcomingView(open: open).id(session.workspace?.id)
                case .feedback:
                    FeedbackView(open: open).id(session.workspace?.id)
                case .workspaceSettings:
                    WorkspaceSettingsView().id(session.workspace?.id)
                case .settings:
                    SettingsView(open: open)
                case nil:
                    EmptyState(title: "Choose a chat")
                }
            }
        }
        // Artifacts start open where there is room for them, as on the web.
        .onAppear {
            showArtifacts = sizeClass == .regular
            openHome()
            openTapped()
            openDictation()
        }
        .onChange(of: session.workspace?.id) {
            openHome()
            openTapped()
            openDictation()
        }
        .onChange(of: Push.shared.tapped) { openTapped() }
        .onChange(of: Dictation.shared.requested) { openDictation() }
    }

    /// Opens the Golem chat, whose composer then starts dictating.
    private func openDictation() {
        if let orchestrator = session.orchestrator, Dictation.shared.take(for: orchestrator.id) {
            open(.chat(orchestrator.id))
        }
    }

    private func openTapped() {
        if let destination = session.takeTapped() { open(destination) }
    }

    private func open(_ destination: Destination) {
        selection = destination
        column = .detail
        if let key = destination.key { opened = key }
    }

    /// Opens the topic or chat this device had open last, if it is in the workspace, else the orchestrator.
    private func openHome() {
        let topics = session.topics
        let orchestrator = session.orchestrator.map { Destination.chat($0.id) }
        let destinations = Array([orchestrator].compactMap { $0 }) + topics.flatMap { topic in
            [Destination.topic(topic.id)] + topic.chats.map { .chat($0.id) }
        }
        let general = topics.first { $0.name == "general" } ?? topics.first
        if let home = destinations.first(where: { $0.key == opened }) ?? orchestrator
            ?? general.map({ .topic($0.id) }) {
            open(home)
        } else {
            selection = nil
        }
    }
}

private struct Sidebar: View {
    let selection: Destination?
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var newTopic = false
    @State private var showSettled = false
    /// The ids of the topics whose chats this device hides, joined by commas.
    @AppStorage("foldedTopics") private var folded = ""

    private var settledChats: [ChatSummary] {
        session.topics.flatMap(\.chats).filter { $0.settledAt != nil }
            .sorted { ($0.settledAt ?? 0) > ($1.settledAt ?? 0) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 1) {
                if let orchestrator = session.orchestrator {
                    row("Golem", pixel: .golem, destination: .chat(orchestrator.id),
                        working: session.working.contains(orchestrator.id), golem: true)
                }
                row("Inbox", pixel: .bell, destination: .inbox, count: session.inbox?.unread)
                row("Search", pixel: .search, destination: .search)
                row("Upcoming", pixel: .agenda, destination: .upcoming)
                row("Following", pixel: .eye, destination: .following)
                SectionHeader(title: "Topics")
                ForEach(session.topics.filter { $0.ownerId == nil }) { topicRow($0) }
                Button {
                    newTopic = true
                } label: {
                    NavRow(title: "New topic", pixel: .plus)
                }
                .buttonStyle(.plain)
                let privateTopics = session.topics.filter { $0.ownerId != nil }
                if session.owner || !privateTopics.isEmpty {
                    SectionHeader(title: "Private")
                    ForEach(privateTopics) { topicRow($0) }
                    if session.owner {
                        row("Feedback", pixel: .info, destination: .feedback)
                    }
                }
                SectionHeader(title: "Golem")
                row("Workspace settings", pixel: .members, destination: .workspaceSettings)
                row("Settings", pixel: .settings, destination: .settings)
            }
            .padding(.horizontal, Tokens.Space.lg)
        }
        .refreshable { await session.run { try await session.reloadWorkspace() } }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !settledChats.isEmpty {
                VStack(spacing: Tokens.Space.xs) {
                    Button { showSettled.toggle() } label: {
                        NavRow(title: "Settled", pixel: .inbox, count: settledChats.count)
                    }
                    .buttonStyle(.plain)
                    if showSettled {
                        ScrollView {
                            VStack(spacing: 1) {
                                ForEach(settledChats) { chat in chatRow(chat) }
                            }
                        }
                        .frame(maxHeight: Tokens.Size.settledShelf)
                    }
                }
                .padding(.horizontal, Tokens.Space.lg)
                .background(Tokens.Colors.canvas)
            }
        }
        .background(Tokens.Colors.canvas)
        .navigationTitle("Golem")
        .sheet(isPresented: $newTopic) {
            NewTopicDialog { name, isPrivate in
                if let topic = try await session.createTopic(name: name, isPrivate: isPrivate) {
                    open(.topic(topic.id))
                }
            }
        }
    }

    private func row(
        _ title: String, pixel: Pixel, destination: Destination, working: Bool = false, count: Int? = nil,
        emoji: String? = nil, locked: Bool = false, golem: Bool = false
    ) -> some View {
        Button {
            open(destination)
        } label: {
            NavRow(
                title: title, pixel: pixel, selected: selection == destination,
                count: count == 0 ? nil : count, working: working, emoji: emoji, locked: locked, golem: golem
            )
        }
        .buttonStyle(.plain)
    }

    private func topicRow(_ topic: Topic) -> some View {
        let chats = topic.chats.filter { $0.settledAt == nil }
        let open = !folded.split(separator: ",").contains { $0 == topic.id }
        return VStack(spacing: 1) {
            HStack(spacing: Tokens.Space.xs) {
                row(topic.name, pixel: .hash, destination: .topic(topic.id), emoji: topic.icon,
                    locked: topic.ownerId != nil)
                    .frame(maxWidth: .infinity)
                if !chats.isEmpty {
                    Button(open ? "Fold chats" : "Unfold chats", pixel: .forward) {
                        withAnimation(.snappy) { toggleFolded(topic.id) }
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .font(.system(size: Tokens.Size.icon * 0.6, weight: .semibold))
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .foregroundStyle(Tokens.Colors.textTertiary)
                    .frame(minWidth: 44, minHeight: 44)
                }
            }
            if open {
                VStack(spacing: 1) {
                    ForEach(chats) { chat in
                        chatRow(chat)
                    }
                }
                .padding(.leading, Tokens.Space.xl)
            }
        }
    }

    private func toggleFolded(_ topicID: String) {
        var ids = folded.split(separator: ",").map(String.init)
        if let index = ids.firstIndex(of: topicID) { ids.remove(at: index) } else { ids.append(topicID) }
        folded = ids.joined(separator: ",")
    }

    private func chatRow(_ chat: ChatSummary) -> some View {
        HStack(spacing: Tokens.Space.xs) {
            row(chat.title, pixel: .compose, destination: .chat(chat.id),
                working: session.working.contains(chat.id))
                .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
                .frame(maxWidth: .infinity)
            Button(chat.settledAt == nil ? "Settle chat" : "Un-settle chat",
                   pixel: chat.settledAt == nil ? .check : .inbox) {
                Task {
                    await session.run {
                        try await session.setChatSettled(chatID: chat.id, settled: chat.settledAt == nil)
                        if selection == .chat(chat.id) { open(.topic(chat.topicId)) }
                    }
                }
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.plain)
            .foregroundStyle(Tokens.Colors.textTertiary)
            .frame(minWidth: 44, minHeight: 44)
        }
    }
}

/// A dialog that asks for a new topic's name, and whether only the person sees it. It stays open when creating
/// fails.
struct NewTopicDialog: View {
    let create: (String, Bool) async throws -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var isPrivate = false
    @State private var busy = false

    var body: some View {
        Dialog(title: "New topic") {
            GolemTextField("Name", text: $name, autofocus: true)
                .onSubmit(submit)
                .textInputAutocapitalization(.never)
            Toggle(isOn: $isPrivate) { Text("Private") }
                .toggleStyle(.golemSwitch)
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button("Create", action: submit)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private func submit() {
        let name = name
        let isPrivate = isPrivate
        guard !busy, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        busy = true
        Task {
            await session.run {
                try await create(name, isPrivate)
                dismiss()
            }
            busy = false
        }
    }
}

/// Asks before a topic merges into another. It stays open when merging fails.
struct MergeDialog: View {
    let title: String
    let message: String
    let merge: () async throws -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false

    var body: some View {
        Dialog(title: title) {
            Text(message)
                .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.regular))
                .foregroundStyle(Tokens.Colors.textSecondary)
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button("Merge") {
                busy = true
                Task {
                    await session.run {
                        try await merge()
                        dismiss()
                    }
                    busy = false
                }
            }
            .buttonStyle(.golem(.primary, .large))
            .disabled(busy)
        }
    }
}
