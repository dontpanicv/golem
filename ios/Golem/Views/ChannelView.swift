import SwiftUI

/// The threads of one channel. Sending from the composer starts a new thread.
struct ChannelView: View {
    let channelID: String
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var draft = ""
    @State private var files: [URL] = []
    @State private var sending = false

    private var channel: Channel? { session.channels.first { $0.id == channelID } }

    var body: some View {
        ScrollView {
            VStack(spacing: 1) {
                ForEach(channel?.threads ?? []) { thread in
                    Button {
                        open(.thread(thread.id))
                    } label: {
                        NavRow(title: thread.title, systemImage: "square.and.pencil")
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(Tokens.Space.lg)
        }
        .overlay {
            if channel?.threads.isEmpty ?? true { EmptyState(title: "Ask Golem anything", systemImage: "sparkles") }
        }
        .safeAreaInset(edge: .bottom) {
            Composer(placeholder: "Message \(channel?.name ?? "")", draft: $draft, files: $files, send: send)
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
