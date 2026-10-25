import SwiftUI

/// Searches the open workspace, never another; results update as you type, like the web search page.
struct SearchView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var query = ""
    @State private var response: SearchResponse?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.md) {
                GolemTextField(nil, placeholder: "Search \(session.workspace?.name ?? "")", text: $query, large: true, autofocus: true)
                    .submitLabel(.search)
                if let response, !response.semantic, !query.isEmpty {
                    Text("Matching words only while the search model starts.")
                        .font(.golem(Tokens.FontSize.sm))
                        .foregroundStyle(Tokens.Colors.textTertiary)
                }
                if let results = response?.results {
                    if results.isEmpty, !query.isEmpty {
                        EmptyState(title: "Nothing found", systemImage: "magnifyingglass")
                    }
                    ForEach(results) { result in
                        Button {
                            if let thread = result.threadId, result.kind == "thread" { open(.thread(thread)) }
                        } label: {
                            SearchRow(result: result, channel: session.channels.first { $0.id == result.channelId }?.name)
                        }
                        .buttonStyle(.plain)
                        .disabled(result.kind != "thread")
                    }
                }
            }
            .padding(Tokens.Space.xl)
        }
        .background(Tokens.Colors.surface)
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: query) {
            // Waits for a pause in typing; a new keystroke cancels this task.
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled, let workspace = session.workspace else { return }
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                response = nil
                return
            }
            response = try? await session.api.search(workspaceID: workspace.id, query: query)
        }
    }
}

private struct SearchRow: View {
    let result: SearchResult
    let channel: String?

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.md) {
            Image(systemName: icon)
                .font(.system(size: Tokens.Size.icon * 0.8, weight: .medium))
                .foregroundStyle(Tokens.Colors.textTertiary)
                .frame(width: Tokens.Size.icon)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(result.title)
                    .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
                    .foregroundStyle(Tokens.Colors.text)
                Text(result.snippet)
                    .font(.golem(Tokens.FontSize.sm))
                    .foregroundStyle(Tokens.Colors.textTertiary)
                    .lineLimit(3)
                Text(place)
                    .font(.golem(Tokens.FontSize.xs))
                    .foregroundStyle(Tokens.Colors.textQuaternary)
            }
            Spacer(minLength: 0)
        }
        .padding(Tokens.Space.md)
        .frame(minHeight: Tokens.Size.listRow)
        .contentShape(.rect)
    }

    private var place: String {
        let date = Date(milliseconds: result.updatedAt).formatted(.dateTime.day().month(.abbreviated))
        return channel.map { "#\($0) · \(date)" } ?? date
    }

    private var icon: String {
        switch (result.modality, result.kind) {
        case ("image", _): "photo"
        case ("audio", _): "waveform"
        case (_, "thread"): "square.and.pencil"
        case (_, "capture"): "tray"
        default: "doc"
        }
    }
}
