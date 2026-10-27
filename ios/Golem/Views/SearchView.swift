import QuickLook
import SwiftUI

/// Searches the open workspace, never another, from a field at the top as Slack's search; results update as you
/// type, like the web search page. Before a query it lists the places to go.
struct SearchView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var query = ""
    @State private var response: SearchResponse?
    @State private var preview: URL?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    if let orchestrator = session.orchestrator {
                        Button { open(.thread(orchestrator.id)) } label: { ListRow("Golem", systemImage: "sparkles") }
                            .buttonStyle(.row)
                    }
                    ListSectionHeader(title: "Channels")
                    ForEach(session.channels) { channel in
                        Button { open(.channel(channel.id)) } label: { ListRow(channel.name, systemImage: "number") }
                            .buttonStyle(.row)
                    }
                } else {
                    if let response, !response.semantic {
                        Text("Matching words only while the search model starts.")
                            .font(.golem(Tokens.Mobile.FontSize.small))
                            .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                            .padding(.horizontal, Tokens.Mobile.Size.margin)
                            .padding(.vertical, Tokens.Space.sm)
                    }
                    ForEach(response?.results ?? []) { result in
                        Button { show(result) } label: {
                            let channel = session.channels.first { $0.id == result.channelId }
                            SearchRow(result: result, channel: channel?.name)
                        }
                        .buttonStyle(.row)
                        .disabled(!opens(result))
                        .padding(.horizontal, 10)
                        .transition(.opacity)
                    }
                }
            }
        }
        .overlay {
            if response?.results.isEmpty == true, !query.trimmingCharacters(in: .whitespaces).isEmpty {
                EmptyState(title: "Nothing found", systemImage: "magnifyingglass")
            }
        }
        .animation(.snappy, value: response?.results.map(\.id))
        .scrollDismissesKeyboard(.immediately)
        .searchable(
            text: $query, placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search \(session.workspace?.name ?? "")"
        )
        .autocorrectionDisabled()
        .phoneTabBar()
        .mobileBackground()
        .quickLookPreview($preview)
        .screenTitle("Search")
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

    /// Opens an artifact where it belongs, a saved file in Quick Look, or a thread.
    private func show(_ result: SearchResult) {
        if result.kind == "artifact" {
            open(.artifact(channel: result.channelId, artifact: String(result.uri.dropFirst("artifact:".count))))
        } else if let file = savedFile(result), let workspace = session.workspace {
            Task {
                await session.run { preview = try await session.api.download(workspaceID: workspace.id, file: file) }
            }
        } else if let thread = result.threadId, result.kind == "thread" {
            open(.thread(thread))
        }
    }

    private func opens(_ result: SearchResult) -> Bool {
        result.kind == "artifact" || result.kind == "thread" || savedFile(result) != nil
    }

    /// A file Golem saved: `channels/<channel>/files/<uuidv7>-<name>`, or `files/<uuidv7>-<name>` of the workspace.
    private func savedFile(_ result: SearchResult) -> FileRef? {
        guard let match = result.uri.firstMatch(of: /^(?:channels\/[^\/]+\/)?files\/([0-9a-f-]{36})-(.+)$/) else {
            return nil
        }
        return FileRef(id: String(match.1), name: String(match.2))
    }
}

private struct SearchRow: View {
    let result: SearchResult
    let channel: String?

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.md) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                .frame(width: 21)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(result.title)
                    .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Mobile.Colors.text)
                Text(result.snippet)
                    .font(.golem(Tokens.Mobile.FontSize.small))
                    .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                    .lineLimit(3)
                Text(place)
                    .font(.golem(Tokens.Mobile.FontSize.caption))
                    .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, Tokens.Space.md)
        .frame(minHeight: Tokens.Mobile.Size.row)
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
        case (_, "artifact"): "shippingbox"
        case (_, "capture"): "tray"
        default: "doc"
        }
    }
}
