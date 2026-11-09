import SwiftUI

/// The open workspace, as Slack's Home: its newest open chats and its topics, in sections that fold.
/// The round button starts a chat or a topic.
struct HomeView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var chatsFolded = false
    @State private var allChats = false
    @State private var topicsFolded = false
    @State private var privateFolded = false
    @State private var newTopic = false

    private var openChats: [ChatSummary] {
        session.topics.flatMap(\.chats).filter { $0.settledAt == nil }.sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !openChats.isEmpty {
                    FoldingSection(title: "Chats", folded: $chatsFolded) {
                        ForEach(allChats ? openChats : Array(openChats.prefix(3))) { chatRow($0) }
                        // Only the newest chats show, so many chats do not push the topics down.
                        if openChats.count > 3 {
                            Button { withAnimation(.snappy) { allChats.toggle() } } label: {
                                ListRow(allChats ? "Show less" : "Show more",
                                        pixel: allChats ? .chevronUp : .chevron)
                            }
                            .buttonStyle(.row)
                        }
                    }
                    ListSeparator()
                }
                FoldingSection(title: "Topics", folded: $topicsFolded) {
                    ForEach(session.topics.filter { $0.ownerId == nil }) { topicRow($0) }
                }
                let privateTopics = session.topics.filter { $0.ownerId != nil }
                if session.owner || !privateTopics.isEmpty {
                    ListSeparator()
                    FoldingSection(title: "Private", folded: $privateFolded) {
                        ForEach(privateTopics) { topicRow($0) }
                        if session.owner {
                            Button { open(.feedback) } label: { ListRow("Feedback", pixel: .info) }
                                .buttonStyle(.row)
                        }
                    }
                }
            }
            .padding(.bottom, Tokens.Mobile.Size.voice + Tokens.Space.xl)
            .animation(.snappy, value: openChats)
        }
        .returnsToEnd()
        .overlay(alignment: .bottomTrailing) { newMenu }
        .refreshable { await session.run { try await session.reloadWorkspace() } }
        .phoneTabBar()
        .mobileBackground()
        // A bar, as on the other tabs: the back button of a screen pushed from here then fades where it is instead of
        // sliding away with a bar that Home would hide.
        .screenTitle(session.workspace?.name ?? "Home")
        .sheet(isPresented: $newTopic) {
            NewTopicDialog { name, isPrivate in
                if let topic = try await session.createTopic(name: name, isPrivate: isPrivate) {
                    open(.topic(topic.id))
                }
            }
        }
    }

    /// The square button over the bar, as Slack's: a new chat in a topic, or a new topic.
    private var newMenu: some View {
        Menu {
            Button("New topic", pixel: .hash) { newTopic = true }
            if !session.topics.isEmpty {
                Menu("New chat", pixel: .compose) {
                    ForEach(session.topics) { topic in
                        Button("# \(topic.name)") { open(.newChat(topic.id)) }
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

    private func chatRow(_ chat: ChatSummary) -> some View {
        Button { open(.chat(chat.id)) } label: {
            let topic = session.topics.first { $0.id == chat.topicId }?.name
            ListRow(
                chat.title, pixel: .chat, subtitle: topic.map { "# \($0)" },
                working: session.working.contains(chat.id)
            )
        }
        .buttonStyle(.row)
        .contextMenu {
            Button("Settle chat", pixel: .check) {
                Task { await session.run { try await session.setChatSettled(chatID: chat.id, settled: true) } }
            }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private func topicRow(_ topic: Topic) -> some View {
        let open = topic.chats.filter { $0.settledAt == nil }
        return Button { self.open(.topic(topic.id)) } label: {
            ListRow(title: topic.name, pixel: .hash,
                    working: open.contains { session.working.contains($0.id) }, emoji: topic.icon) {
                if topic.ownerId != nil {
                    Image(pixel: .lock)
                        .font(.system(size: 12))
                        .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                        .accessibilityLabel("Private")
                }
                if !open.isEmpty {
                    Text("\(open.count)")
                        .font(.mono(Tokens.Mobile.FontSize.mono, Tokens.FontWeight.medium))
                        .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                        .contentTransition(.numericText(value: Double(open.count)))
                }
            }
        }
        .buttonStyle(.row)
    }
}
