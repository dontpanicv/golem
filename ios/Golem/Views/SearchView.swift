import SwiftUI

/// Searches the open workspace, never another, from a field at the top as Slack's search; results update as you
/// type, like the web search page. Before a query it lists the person's recent searches, then Golem.
struct SearchView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var query = ""
    @State private var response: SearchResponse?
    @State private var recent: [RecentSearch] = []
    @State private var opening: FileRef?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    ForEach(recent) { search in
                        Button { query = search.query } label: {
                            ListRow(title: search.query, pixel: .clock) {
                                Text(Date(milliseconds: search.searchedAt), format: .relative(presentation: .named))
                                    .font(.golem(Tokens.Mobile.FontSize.caption))
                                    .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                            }
                        }
                        .buttonStyle(.row)
                    }
                    if let orchestrator = session.orchestrator {
                        Button { open(.thread(orchestrator.id)) } label: {
                            ListRow(title: "Golem", golem: true) { EmptyView() }
                        }
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
        .returnsToEnd()
        .overlay {
            if response?.results.isEmpty == true, !query.trimmingCharacters(in: .whitespaces).isEmpty {
                EmptyState(title: "Nothing found")
            }
        }
        .animation(.snappy, value: response?.results.map(\.id))
        .scrollDismissesKeyboard(.immediately)
        .searchable(
            text: $query, placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search \(session.workspace?.name ?? "")"
        )
        .onSubmit(of: .search) { save() }
        .autocorrectionDisabled()
        .phoneTabBar()
        .mobileBackground()
        .filePreview($opening)
        .screenTitle("Search")
        .task(id: session.workspace?.id) {
            guard let workspace = session.workspace,
                  let saved = try? await session.api.recentSearches(workspaceID: workspace.id) else { return }
            recent = saved.searches
        }
        .task(id: query) {
            // Waits for a pause in typing; a new keystroke cancels this task.
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled, let workspace = session.workspace else { return }
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                response = nil
                return
            }
            response = try? await session.api.search(workspaceID: workspace.id, query: query)
            // A search counts once its results rest a second, so the words typed on the way to it do not.
            guard response?.results.isEmpty == false else { return }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            save()
        }
    }

    /// Saves a search the person acted on or that found something; the list of recent searches is only a help, so a
    /// failure stays quiet.
    private func save() {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, let workspace = session.workspace else { return }
        Task {
            if let saved = try? await session.api.saveSearch(workspaceID: workspace.id, query: text) {
                recent = saved.searches
            }
        }
    }

    /// Opens an artifact where it belongs, a saved file in Quick Look, or a thread.
    private func show(_ result: SearchResult) {
        save()
        if result.kind == "artifact" {
            open(.artifact(channel: result.channelId, artifact: String(result.uri.dropFirst("artifact:".count))))
        } else if let file = savedFile(result) {
            opening = file
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
            Image(pixel: icon)
                .font(.system(size: 15))
                .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                .frame(width: 21)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(result.title)
                    .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Mobile.Colors.text)
                if !result.snippet.isEmpty {
                    MarkdownText(text: result.snippet, size: Tokens.Mobile.FontSize.small)
                        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                }
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

    private var icon: Pixel {
        switch (result.modality, result.kind) {
        case ("image", _): .photo
        case ("audio", _): .sound
        case (_, "thread"): .compose
        case (_, "artifact"): .artifact
        case (_, "capture"): .inbox
        default: .file
        }
    }
}
