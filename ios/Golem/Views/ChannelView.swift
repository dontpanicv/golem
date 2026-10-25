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
    @State private var confirmDelete = false

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
            ToolbarItem(placement: .primaryAction) {
                Button("Delete channel", systemImage: "trash") { confirmDelete = true }
            }
        }
        .sheet(isPresented: $confirmDelete) {
            DeleteChannelDialog(name: channel?.name ?? "") {
                try await session.deleteChannel(channelID: channelID)
                if let orchestrator = session.orchestrator { open(.thread(orchestrator.id)) }
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

/// Asks before a channel goes with its threads and routines. It stays open when deleting fails.
private struct DeleteChannelDialog: View {
    let name: String
    let delete: () async throws -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false

    var body: some View {
        Dialog(title: "Delete #\(name)?") {
            Text("Its threads and routines go with it.")
                .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.regular))
                .foregroundStyle(Tokens.Colors.textSecondary)
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button("Delete channel") {
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
