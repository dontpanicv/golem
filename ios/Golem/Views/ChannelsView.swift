import SwiftUI

/// Every channel with its threads, as Linear's My Issues lists issues under their status: the channel's name heads
/// its section and opens it, its add button starts a thread there. The pills show the open or the settled threads.
struct ChannelsView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var shown = Shown.open
    @State private var newChannel = false

    enum Shown: CaseIterable { case open, settled }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                PillBar(selection: $shown, options: Shown.allCases) { $0 == .open ? "Open" : "Settled" } count: {
                    count($0)
                }
                    .padding(.bottom, Tokens.Space.sm)
                ForEach(Array(sections.enumerated()), id: \.element.channel.id) { index, section in
                    if index > 0 { ListSeparator() }
                    ListSectionHeader(
                        title: "# \(section.channel.name)", open: { open(.channel(section.channel.id)) },
                        add: ("New thread in \(section.channel.name)", { open(.newThread(section.channel.id)) })
                    )
                    ForEach(section.threads) { thread in threadRow(thread) }
                }
            }
            .padding(.bottom, Tokens.Space.xxxl)
        }
        .overlay {
            if sections.isEmpty {
                EmptyState(title: shown == .open ? "No channels" : "No settled threads", systemImage: "number")
            }
        }
        .refreshable { await session.run { try await session.reloadWorkspace() } }
        .phoneTabBar()
        .mobileBackground()
        .screenTitle("Channels")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New channel", systemImage: "plus") { newChannel = true }
            }
        }
        .sheet(isPresented: $newChannel) {
            NameDialog(title: "New channel") { name in
                if let channel = try await session.createChannel(name: name) { open(.channel(channel.id)) }
            }
            .textInputAutocapitalization(.never)
        }
    }

    private var sections: [(channel: Channel, threads: [ThreadSummary])] {
        session.channels.compactMap { channel in
            let threads = channel.threads.filter { ($0.settledAt == nil) == (shown == .open) }
            return shown == .open || !threads.isEmpty ? (channel, threads) : nil
        }
    }

    private func count(_ shown: Shown) -> Int {
        session.channels.flatMap(\.threads).filter { ($0.settledAt == nil) == (shown == .open) }.count
    }

    private func threadRow(_ thread: ThreadSummary) -> some View {
        Button { open(.thread(thread.id)) } label: {
            ListRow(thread.title, systemImage: "bubble.left", working: session.working.contains(thread.id))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(thread.settledAt == nil ? "Settle thread" : "Un-settle thread",
                   systemImage: thread.settledAt == nil ? "checkmark" : "tray") {
                Task {
                    await session.run {
                        try await session.setThreadSettled(threadID: thread.id, settled: thread.settledAt == nil)
                    }
                }
            }
        }
    }
}
