import SwiftUI

/// Login, then the open workspace. Every screen reads the server through `Session`.
struct RootView: View {
    @State private var session = Session()

    var body: some View {
        Group {
            if !session.signedIn {
                LoginView()
            } else if session.user == nil {
                LoadingView()
            } else if session.workspaces.isEmpty {
                CreateWorkspaceView()
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
        .background(Tokens.Colors.surface)
    }
}

enum Destination: Hashable {
    case search
    case channel(String)
    case thread(String)
    case workspaceSettings
    case settings

    /// What `MainView` remembers, so the app opens on the last channel or thread.
    var key: String? {
        switch self {
        case let .channel(id): "channel:\(id)"
        case let .thread(id): "thread:\(id)"
        default: nil
        }
    }
}

/// Channels with their threads on the left, the open screen in the detail column, artifacts in the inspector.
/// On iPhone the split view collapses into a stack and the inspector becomes a sheet.
private struct MainView: View {
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
            switch selection {
            case .search:
                SearchView(open: open).id(session.workspace?.id)
            case let .channel(id):
                ChannelView(channelID: id, open: open).id(id)
            case let .thread(id):
                ConversationView(threadID: id, showArtifacts: $showArtifacts, open: open).id(id)
            case .workspaceSettings:
                WorkspaceSettingsView().id(session.workspace?.id)
            case .settings:
                SettingsView()
            case nil:
                EmptyState(title: "Choose a thread", systemImage: "bubble.left.and.bubble.right")
            }
        }
        // Artifacts start open where there is room for them, as on the web.
        .onAppear {
            showArtifacts = sizeClass == .regular
            openHome()
        }
        .onChange(of: session.workspace?.id) { openHome() }
    }

    private func open(_ destination: Destination) {
        selection = destination
        column = .detail
        if let key = destination.key { opened = key }
    }

    /// Opens the channel or thread this device had open last, if it is in the workspace, else #general.
    private func openHome() {
        let channels = session.channels
        let destinations = channels.flatMap { channel in
            [Destination.channel(channel.id)] + channel.threads.map { .thread($0.id) }
        }
        let general = channels.first { $0.name == "general" } ?? channels.first
        if let home = destinations.first(where: { $0.key == opened }) ?? general.map({ .channel($0.id) }) {
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
    @State private var newWorkspace = false

    var body: some View {
        ScrollView {
            VStack(spacing: 1) {
                workspaceMenu
                row("Search", systemImage: "magnifyingglass", destination: .search)
                SectionHeader(title: "Channels")
                ForEach(session.channels) { channel in
                    row(channel.name, systemImage: "number", destination: .channel(channel.id))
                    VStack(spacing: 1) {
                        ForEach(channel.threads) { thread in
                            row(thread.title, systemImage: "square.and.pencil", destination: .thread(thread.id))
                                .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
                        }
                    }
                    .padding(.leading, Tokens.Space.xl)
                }
                Button {
                    newChannel = true
                } label: {
                    NavRow(title: "New channel", systemImage: "plus")
                }
                .buttonStyle(.plain)
                SectionHeader(title: "Golem")
                row("Workspace settings", systemImage: "person.2", destination: .workspaceSettings)
                row("Settings", systemImage: "gearshape", destination: .settings)
            }
            .padding(.horizontal, Tokens.Space.lg)
        }
        .refreshable { await session.run { try await session.reloadWorkspace() } }
        .background(Tokens.Colors.canvas)
        .navigationTitle("Golem")
        .sheet(isPresented: $newChannel) {
            NameDialog(title: "New channel") { name in
                if let channel = try await session.createChannel(name: name) { open(.channel(channel.id)) }
            }
            .textInputAutocapitalization(.never)
        }
        .sheet(isPresented: $newWorkspace) {
            NameDialog(title: "New workspace") { name in try await session.createWorkspace(name: name) }
        }
    }

    private var workspaceMenu: some View {
        GolemMenu {
            MenuSectionLabel("Workspaces")
            ForEach(session.workspaces) { workspace in
                MenuItem(workspace.name, checked: workspace.id == session.workspace?.id) {
                    Task { await session.run { try await session.open(workspace) } }
                }
            }
            MenuSeparator()
            MenuItem("New workspace", systemImage: "plus") { newWorkspace = true }
        } label: {
            HStack(spacing: Tokens.Space.md) {
                Avatar(name: session.workspace?.name ?? "G", agent: true)
                Text(session.workspace?.name ?? "Workspaces")
                    .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.semibold))
                    .foregroundStyle(Tokens.Colors.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: Tokens.Size.icon * 0.7, weight: .medium))
                    .foregroundStyle(Tokens.Colors.textTertiary)
            }
            .padding(.horizontal, Tokens.Space.sm)
            .frame(minHeight: Tokens.Size.listRow)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Workspace")
        .accessibilityValue(session.workspace?.name ?? "")
    }

    private func row(_ title: String, systemImage: String, destination: Destination) -> some View {
        Button {
            open(destination)
        } label: {
            NavRow(title: title, systemImage: systemImage, selected: selection == destination)
        }
        .buttonStyle(.plain)
    }
}

/// A dialog that asks for a name: new channel and new workspace. It stays open when creating fails.
private struct NameDialog: View {
    let title: String
    let create: (String) async throws -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var busy = false

    var body: some View {
        Dialog(title: title) {
            GolemTextField("Name", text: $name, autofocus: true)
                .onSubmit(submit)
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button("Create", action: submit)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private func submit() {
        let name = name
        guard !busy, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        busy = true
        Task {
            await session.run {
                try await create(name)
                dismiss()
            }
            busy = false
        }
    }
}
