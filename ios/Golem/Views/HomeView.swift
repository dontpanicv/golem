import SwiftUI

/// The open workspace, as Slack's Home: its newest open threads and its channels, in sections that fold.
/// The round button starts a thread or a channel.
struct HomeView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var threadsFolded = false
    @State private var allThreads = false
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
                        ForEach(allThreads ? openThreads : Array(openThreads.prefix(3))) { threadRow($0) }
                        // Only the newest threads show, so many threads do not push the channels down.
                        if openThreads.count > 3 {
                            Button { withAnimation(.snappy) { allThreads.toggle() } } label: {
                                ListRow(allThreads ? "Show less" : "Show more",
                                        pixel: allThreads ? .chevronUp : .chevron)
                            }
                            .buttonStyle(.row)
                        }
                    }
                    ListSeparator()
                }
                FoldingSection(title: "Channels", folded: $channelsFolded) {
                    ForEach(session.channels.filter { $0.ownerId == nil }) { channelRow($0) }
                }
                let privateChannels = session.channels.filter { $0.ownerId != nil }
                if session.owner || !privateChannels.isEmpty {
                    ListSeparator()
                    FoldingSection(title: "Private", folded: $privateFolded) {
                        ForEach(privateChannels) { channelRow($0) }
                        if session.owner {
                            Button { open(.feedback) } label: { ListRow("Feedback", pixel: .info) }
                                .buttonStyle(.row)
                        }
                    }
                }
            }
            .padding(.bottom, Tokens.Mobile.Size.voice + Tokens.Space.xl)
            .animation(.snappy, value: openThreads)
        }
        .returnsToEnd()
        .overlay(alignment: .bottomTrailing) { newMenu }
        .refreshable { await session.run { try await session.reloadWorkspace() } }
        .phoneTabBar()
        .mobileBackground()
        // A bar, as on the other tabs: the back button of a screen pushed from here then fades where it is instead of
        // sliding away with a bar that Home would hide.
        .screenTitle(session.workspace?.name ?? "Home")
        .sheet(isPresented: $newChannel) {
            NewChannelDialog { name, isPrivate in
                if let channel = try await session.createChannel(name: name, isPrivate: isPrivate) {
                    open(.channel(channel.id))
                }
            }
        }
    }

    /// The square button over the bar, as Slack's: a new thread in a channel, or a new channel.
    private var newMenu: some View {
        Menu {
            Button("New channel", pixel: .hash) { newChannel = true }
            if !session.channels.isEmpty {
                Menu("New thread", pixel: .compose) {
                    ForEach(session.channels) { channel in
                        Button("# \(channel.name)") { open(.newThread(channel.id)) }
                    }
                }
            }
        } label: {
            Image(pixel: .plus)
                .foregroundStyle(Tokens.Colors.onAccent)
                .frame(width: Tokens.Mobile.Size.voice, height: Tokens.Mobile.Size.voice)
                .glassEffect(.regular.tint(Tokens.Colors.accent).interactive(), in: .rect)
        }
        .accessibilityLabel("New")
        .padding(.trailing, Tokens.Mobile.Size.margin)
        .padding(.bottom, Tokens.Space.md)
    }

    private func threadRow(_ thread: ThreadSummary) -> some View {
        Button { open(.thread(thread.id)) } label: {
            let channel = session.channels.first { $0.id == thread.channelId }?.name
            ListRow(
                thread.title, pixel: .chat, subtitle: channel.map { "# \($0)" },
                working: session.working.contains(thread.id)
            )
        }
        .buttonStyle(.row)
        .contextMenu {
            Button("Settle thread", pixel: .check) {
                Task { await session.run { try await session.setThreadSettled(threadID: thread.id, settled: true) } }
            }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private func channelRow(_ channel: Channel) -> some View {
        let open = channel.threads.filter { $0.settledAt == nil }
        return Button { self.open(.channel(channel.id)) } label: {
            ListRow(title: channel.name, pixel: .hash,
                    working: open.contains { session.working.contains($0.id) }, emoji: channel.icon) {
                if channel.ownerId != nil {
                    Image(pixel: .lock)
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
