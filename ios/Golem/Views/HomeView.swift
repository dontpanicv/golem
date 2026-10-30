import SwiftUI

/// The open workspace, as Slack's Home: its open threads, newest first, and its channels, in sections that fold. The
/// workspace's name opens the workspace panel, the person's avatar the settings, and the round button starts a thread
/// or a channel.
struct HomeView: View {
    let open: (Destination) -> Void
    let showWorkspaces: () -> Void
    @Environment(Session.self) private var session
    @State private var threadsFolded = false
    @State private var channelsFolded = false
    @State private var privateFolded = false
    @State private var newChannel = false

    private var openThreads: [ThreadSummary] {
        session.channels.flatMap(\.threads).filter { $0.settledAt == nil }.sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !openThreads.isEmpty {
                    FoldingSection(title: "Threads", folded: $threadsFolded) {
                        ForEach(openThreads) { threadRow($0) }
                    }
                    ListSeparator()
                }
                FoldingSection(title: "Channels", folded: $channelsFolded) {
                    ForEach(session.channels.filter { $0.ownerId == nil }) { channelRow($0) }
                    Button { newChannel = true } label: { ListRow("Add channel", systemImage: "plus") }
                        .buttonStyle(.row)
                }
                let privateChannels = session.channels.filter { $0.ownerId != nil }
                if !privateChannels.isEmpty {
                    ListSeparator()
                    FoldingSection(title: "Private", folded: $privateFolded) {
                        ForEach(privateChannels) { channelRow($0) }
                    }
                }
            }
            .padding(.bottom, Tokens.Mobile.Size.voice + Tokens.Space.xl)
            .animation(.snappy, value: openThreads)
        }
        .overlay(alignment: .bottomTrailing) { newMenu }
        .refreshable { await session.run { try await session.reloadWorkspace() } }
        .phoneTabBar()
        .mobileBackground()
        .navigationTitle(session.workspace?.name ?? "Home")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(removing: .title)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { workspaceButton }
                .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) { profileMenu }
                .sharedBackgroundVisibility(.hidden)
        }
        .sheet(isPresented: $newChannel) {
            NewChannelDialog { name, isPrivate in
                if let channel = try await session.createChannel(name: name, isPrivate: isPrivate) {
                    open(.channel(channel.id))
                }
            }
        }
    }

    /// The workspace's avatar and name, as Slack's: a tap opens the workspace panel.
    private var workspaceButton: some View {
        Button(action: showWorkspaces) {
            HStack(spacing: Tokens.Space.md) {
                Avatar(name: session.workspace?.name ?? "G", agent: true, size: Tokens.Mobile.Size.avatar)
                Text(session.workspace?.name ?? "")
                    .font(.golem(Tokens.Mobile.FontSize.detailTitle, Tokens.FontWeight.semibold))
                    .foregroundStyle(Tokens.Mobile.Colors.title)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.leading, -Tokens.Space.md)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Menu")
        .accessibilityValue(session.workspace?.name ?? "")
    }

    private var profileMenu: some View {
        Menu {
            Section(session.user?.name ?? "") {
                Button("Settings", systemImage: "gearshape") { open(.settings) }
                Button("Workspace settings", systemImage: "person.2") { open(.workspaceSettings) }
            }
        } label: {
            Avatar(name: session.user?.name ?? "", size: Tokens.Mobile.Size.avatar)
        }
        .accessibilityLabel("Profile")
    }

    /// The round button over the bar, as Slack's: a new thread in a channel, or a new channel.
    private var newMenu: some View {
        Menu {
            Button("New channel", systemImage: "number") { newChannel = true }
            if !session.channels.isEmpty {
                Menu("New thread", systemImage: "square.and.pencil") {
                    ForEach(session.channels) { channel in
                        Button("# \(channel.name)") { open(.newThread(channel.id)) }
                    }
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Tokens.Colors.onAccent)
                .frame(width: Tokens.Mobile.Size.voice, height: Tokens.Mobile.Size.voice)
                .glassEffect(.regular.tint(Tokens.Colors.accent).interactive(), in: .circle)
        }
        .accessibilityLabel("New")
        .padding(.trailing, Tokens.Mobile.Size.margin)
        .padding(.bottom, Tokens.Space.md)
    }

    private func threadRow(_ thread: ThreadSummary) -> some View {
        Button { open(.thread(thread.id)) } label: {
            let channel = session.channels.first { $0.id == thread.channelId }?.name
            ListRow(
                thread.title, systemImage: "bubble.left", subtitle: channel.map { "# \($0)" },
                working: session.working.contains(thread.id)
            )
        }
        .buttonStyle(.row)
        .contextMenu {
            Button("Settle thread", systemImage: "checkmark") {
                Task { await session.run { try await session.setThreadSettled(threadID: thread.id, settled: true) } }
            }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private func channelRow(_ channel: Channel) -> some View {
        let open = channel.threads.filter { $0.settledAt == nil }
        return Button { self.open(.channel(channel.id)) } label: {
            ListRow(title: channel.name, systemImage: "number",
                    working: open.contains { session.working.contains($0.id) }, emoji: channel.icon) {
                if channel.ownerId != nil {
                    Image(systemName: "lock")
                        .font(.system(size: 12))
                        .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                        .accessibilityLabel("Private")
                }
                if !open.isEmpty {
                    Text("\(open.count)")
                        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
                        .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                        .contentTransition(.numericText(value: Double(open.count)))
                }
            }
        }
        .buttonStyle(.row)
    }
}
