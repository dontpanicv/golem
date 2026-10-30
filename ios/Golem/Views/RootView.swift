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
        // Threads read on screen read their notifications, so the inbox and the app icon load again.
        .onChange(of: scenePhase) {
            if scenePhase != .inactive { Task { try? await session.loadInbox() } }
        }
    }
}

private struct LoadingView: View {
    @Environment(Session.self) private var session

    var body: some View {
        VStack(spacing: Tokens.Space.lg) {
            if let error = session.loadError {
                EmptyState(title: error, systemImage: "wifi.exclamationmark")
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
    case channel(String)
    /// A channel with its composer focused, to start a thread.
    case newThread(String)
    /// A channel with one of its artifacts open, or the orchestrator with one of the workspace's own for a nil channel.
    case artifact(channel: String?, artifact: String)
    case channelDetails(String)
    case thread(String)
    case inbox
    case workspaceSettings
    case settings

    var id: Self { self }

    /// What `MainView` remembers, so the app opens on the last channel or thread.
    var key: String? {
        switch self {
        case let .channel(id): "channel:\(id)"
        case let .thread(id): "thread:\(id)"
        default: nil
        }
    }
}

/// The iPhone shell (``PhoneShell``) or, where there is room, the split view with the sidebar.
private struct MainView: View {
    @Environment(Session.self) private var session
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        Group {
            if sizeClass == .compact { PhoneShell() } else { SplitView() }
        }
        .task(id: session.workspace?.id) { await session.followWorking() }
    }
}

/// Channels with their threads on the left, the open screen in the detail column, artifacts in the inspector.
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
                case let .channel(id):
                    ChannelView(channelID: id, showArtifacts: $showArtifacts, open: open).id(id)
                case let .newThread(id):
                    ChannelView(channelID: id, compose: true, showArtifacts: $showArtifacts, open: open).id(id)
                case let .artifact(channel?, artifact):
                    ChannelView(channelID: channel, artifactID: artifact, showArtifacts: $showArtifacts, open: open)
                        .id(artifact)
                case let .artifact(nil, artifact):
                    if let orchestrator = session.orchestrator {
                        ConversationView(
                            threadID: orchestrator.id, artifactID: artifact, showArtifacts: $showArtifacts, open: open
                        )
                            .id(artifact)
                    }
                case let .channelDetails(id):
                    ChannelDetailsView(channelID: id, open: open).id(id)
                case let .thread(id):
                    ConversationView(threadID: id, showArtifacts: $showArtifacts, open: open).id(id)
                case .inbox:
                    InboxView(open: open).id(session.workspace?.id)
                case .workspaceSettings:
                    WorkspaceSettingsView().id(session.workspace?.id)
                case .settings:
                    SettingsView()
                case nil:
                    EmptyState(title: "Choose a thread", systemImage: "bubble.left.and.bubble.right")
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

    /// Opens the Golem thread, whose composer then starts dictating.
    private func openDictation() {
        if let orchestrator = session.orchestrator, Dictation.shared.take(for: orchestrator.id) {
            open(.thread(orchestrator.id))
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

    /// Opens the channel or thread this device had open last, if it is in the workspace, else the orchestrator.
    private func openHome() {
        let channels = session.channels
        let orchestrator = session.orchestrator.map { Destination.thread($0.id) }
        let destinations = Array([orchestrator].compactMap { $0 }) + channels.flatMap { channel in
            [Destination.channel(channel.id)] + channel.threads.map { .thread($0.id) }
        }
        let general = channels.first { $0.name == "general" } ?? channels.first
        if let home = destinations.first(where: { $0.key == opened }) ?? orchestrator
            ?? general.map({ .channel($0.id) }) {
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
    @State private var newChannel = false
    @State private var showSettled = false

    private var settledThreads: [ThreadSummary] {
        session.channels.flatMap(\.threads).filter { $0.settledAt != nil }
            .sorted { ($0.settledAt ?? 0) > ($1.settledAt ?? 0) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 1) {
                if let orchestrator = session.orchestrator {
                    row("Golem", systemImage: "tray", destination: .thread(orchestrator.id),
                        working: session.working.contains(orchestrator.id))
                }
                row("Inbox", systemImage: "bell", destination: .inbox, count: session.inbox?.unread)
                row("Search", systemImage: "magnifyingglass", destination: .search)
                SectionHeader(title: "Channels")
                ForEach(session.channels.filter { $0.ownerId == nil }) { channelRow($0) }
                Button {
                    newChannel = true
                } label: {
                    NavRow(title: "New channel", systemImage: "plus")
                }
                .buttonStyle(.plain)
                let privateChannels = session.channels.filter { $0.ownerId != nil }
                if !privateChannels.isEmpty {
                    SectionHeader(title: "Private")
                    ForEach(privateChannels) { channelRow($0) }
                }
                SectionHeader(title: "Golem")
                row("Workspace settings", systemImage: "person.2", destination: .workspaceSettings)
                row("Settings", systemImage: "gearshape", destination: .settings)
            }
            .padding(.horizontal, Tokens.Space.lg)
        }
        .refreshable { await session.run { try await session.reloadWorkspace() } }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !settledThreads.isEmpty {
                VStack(spacing: Tokens.Space.xs) {
                    Button { showSettled.toggle() } label: {
                        NavRow(title: "Settled", systemImage: "tray", count: settledThreads.count)
                    }
                    .buttonStyle(.plain)
                    if showSettled {
                        ScrollView {
                            VStack(spacing: 1) {
                                ForEach(settledThreads) { thread in threadRow(thread) }
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
        .sheet(isPresented: $newChannel) {
            NewChannelDialog { name, isPrivate in
                if let channel = try await session.createChannel(name: name, isPrivate: isPrivate) {
                    open(.channel(channel.id))
                }
            }
        }
    }

    private func row(
        _ title: String, systemImage: String, destination: Destination, working: Bool = false, count: Int? = nil,
        emoji: String? = nil, locked: Bool = false
    ) -> some View {
        Button {
            open(destination)
        } label: {
            NavRow(
                title: title, systemImage: systemImage, selected: selection == destination,
                count: count == 0 ? nil : count, working: working, emoji: emoji, locked: locked
            )
        }
        .buttonStyle(.plain)
    }

    private func channelRow(_ channel: Channel) -> some View {
        VStack(spacing: 1) {
            row(channel.name, systemImage: "number", destination: .channel(channel.id), emoji: channel.icon,
                locked: channel.ownerId != nil)
            VStack(spacing: 1) {
                ForEach(channel.threads.filter { $0.settledAt == nil }) { thread in
                    threadRow(thread)
                }
            }
            .padding(.leading, Tokens.Space.xl)
        }
    }

    private func threadRow(_ thread: ThreadSummary) -> some View {
        HStack(spacing: Tokens.Space.xs) {
            row(thread.title, systemImage: "square.and.pencil", destination: .thread(thread.id),
                working: session.working.contains(thread.id))
                .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
                .frame(maxWidth: .infinity)
            Button(thread.settledAt == nil ? "Settle thread" : "Un-settle thread",
                   systemImage: thread.settledAt == nil ? "checkmark" : "tray") {
                Task {
                    await session.run {
                        try await session.setThreadSettled(threadID: thread.id, settled: thread.settledAt == nil)
                        if selection == .thread(thread.id) { open(.channel(thread.channelId)) }
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

/// A dialog that asks for a new channel's name, and whether only the person sees it. It stays open when creating
/// fails.
struct NewChannelDialog: View {
    let create: (String, Bool) async throws -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var isPrivate = false
    @State private var busy = false

    var body: some View {
        Dialog(title: "New channel") {
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

/// Asks before a channel goes with what it holds. It stays open when deleting fails.
struct DeleteDialog: View {
    let title: String
    let message: String
    let submit: String
    let delete: () async throws -> Void
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
            Button(submit) {
                busy = true
                Task {
                    await session.run {
                        try await delete()
                        dismiss()
                    }
                    busy = false
                }
            }
            .buttonStyle(.golem(.danger, .large))
            .disabled(busy)
        }
    }
}
