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
        .environment(session)
        .tint(Tokens.Colors.accent)
        .task(id: session.signedIn) {
            if session.signedIn { await session.load() }
        }
        .alert("Error", isPresented: Binding(get: { session.error != nil }, set: { if !$0 { session.error = nil } })) {
            Button("OK") {}
        } message: {
            Text(session.error ?? "")
        }
    }
}

private struct LoadingView: View {
    @Environment(Session.self) private var session

    var body: some View {
        VStack(spacing: Tokens.Space.lg) {
            if let error = session.loadError {
                EmptyState(title: error, systemImage: "wifi.exclamationmark").fixedSize(horizontal: false, vertical: true)
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
    case channel(String)
    case thread(String)
    case workspaceSettings
    case settings
    case design
}

/// Channels with their threads on the left, the open screen in the detail column, artifacts in the inspector.
/// On iPhone the split view collapses into a stack and the inspector becomes a sheet.
private struct MainView: View {
    @Environment(Session.self) private var session
    @State private var selection: Destination?
    @State private var column = NavigationSplitViewColumn.sidebar
    @State private var showArtifacts = false
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            Sidebar(selection: selection, open: open)
                .navigationSplitViewColumnWidth(Tokens.Size.sidebar)
        } detail: {
            switch selection {
            case let .channel(id):
                ChannelView(channelID: id, open: open).id(id)
            case let .thread(id):
                ConversationView(threadID: id, showArtifacts: $showArtifacts).id(id)
            case .workspaceSettings:
                WorkspaceSettingsView().id(session.workspace?.id)
            case .settings:
                SettingsView()
            case .design:
                DesignCatalogView()
            case nil:
                EmptyState(title: "Choose a thread", systemImage: "bubble.left.and.bubble.right")
            }
        }
        // Artifacts start open where there is room for them, as on the web.
        .onAppear { showArtifacts = sizeClass == .regular }
        .onChange(of: session.workspace?.id) { selection = nil }
    }

    private func open(_ destination: Destination) {
        selection = destination
        column = .detail
    }
}

private struct Sidebar: View {
    let selection: Destination?
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var newChannel = false
    @State private var newWorkspace = false
    @State private var name = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 1) {
                workspaceMenu
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
                    name = ""
                    newChannel = true
                } label: {
                    NavRow(title: "New channel", systemImage: "plus")
                }
                .buttonStyle(.plain)
                SectionHeader(title: "Golem")
                row("Workspace settings", systemImage: "person.2", destination: .workspaceSettings)
                row("Settings", systemImage: "gearshape", destination: .settings)
                row("Design system", systemImage: "paintpalette", destination: .design)
            }
            .padding(.horizontal, Tokens.Space.lg)
        }
        .refreshable { await session.run { try await session.reloadWorkspace() } }
        .background(Tokens.Colors.canvas)
        .navigationTitle("Golem")
        .alert("New channel", isPresented: $newChannel) {
            TextField("Name", text: $name).textInputAutocapitalization(.never)
            Button("Create") {
                let name = name
                Task {
                    await session.run {
                        if let channel = try await session.createChannel(name: name) { open(.channel(channel.id)) }
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("New workspace", isPresented: $newWorkspace) {
            TextField("Name", text: $name)
            Button("Create") {
                let name = name
                Task { await session.run { try await session.createWorkspace(name: name) } }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var workspaceMenu: some View {
        Menu {
            ForEach(session.workspaces) { workspace in
                Button {
                    Task { await session.run { try await session.open(workspace) } }
                } label: {
                    if workspace.id == session.workspace?.id {
                        Label(workspace.name, systemImage: "checkmark")
                    } else {
                        Text(workspace.name)
                    }
                }
            }
            Divider()
            Button("New workspace", systemImage: "plus") {
                name = ""
                newWorkspace = true
            }
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
