import SwiftUI

/// The threads of one channel. Sending from the composer starts a new thread.
struct ChannelView: View {
    let channelID: String
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var draft = ""
    @State private var files: [URL] = []
    @State private var sending = false
    @State private var showSettled = false

    private var channel: Channel? { session.channels.first { $0.id == channelID } }
    private var activeThreads: [ThreadSummary] { channel?.threads.filter { $0.settledAt == nil } ?? [] }
    private var settledThreads: [ThreadSummary] {
        (channel?.threads.filter { $0.settledAt != nil } ?? [])
            .sorted { ($0.settledAt ?? 0) > ($1.settledAt ?? 0) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 1) {
                ForEach(activeThreads) { thread in threadRow(thread) }
                if !settledThreads.isEmpty {
                    Button { showSettled.toggle() } label: {
                        NavRow(title: "Settled", systemImage: "tray", count: settledThreads.count)
                    }
                    .buttonStyle(.plain)
                    if showSettled {
                        ForEach(settledThreads) { thread in threadRow(thread) }
                    }
                }
            }
            .padding(Tokens.Space.lg)
        }
        .overlay {
            if channel?.threads.isEmpty ?? true { EmptyState(title: "Ask Golem anything", systemImage: "sparkles") }
        }
        .safeAreaInset(edge: .bottom) {
            Composer(
                owner: channelID, placeholder: "Message \(channel?.name ?? "")", draft: $draft, files: $files,
                send: send
            )
                .padding([.horizontal, .bottom], Tokens.Space.lg)
        }
        .background(Tokens.Colors.surface)
        .navigationTitle(channel?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Channel details", systemImage: "info.circle") { open(.channelDetails(channelID)) }
            }
        }
        .task { await session.run { try await session.reloadWorkspace() } }
    }

    private func threadRow(_ thread: ThreadSummary) -> some View {
        HStack(spacing: Tokens.Space.xs) {
            Button { open(.thread(thread.id)) } label: {
                NavRow(title: thread.title, systemImage: "square.and.pencil")
            }
            .buttonStyle(.plain)
            Button(thread.settledAt == nil ? "Settle thread" : "Un-settle thread",
                   systemImage: thread.settledAt == nil ? "checkmark" : "tray") {
                Task {
                    await session.run {
                        try await session.setThreadSettled(threadID: thread.id, settled: thread.settledAt == nil)
                    }
                }
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.plain)
            .foregroundStyle(Tokens.Colors.textTertiary)
            .frame(minWidth: 44, minHeight: 44)
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !files.isEmpty, !sending else { return }
        sending = true
        Task {
            await session.run {
                if let thread = try await session.createThread(channelID: channelID, text: text, files: files) {
                    draft = ""
                    files = []
                    open(.thread(thread.id))
                }
            }
            sending = false
        }
    }
}
