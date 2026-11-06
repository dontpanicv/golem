import SwiftUI

/// The person's follow-up ledger. Golem does the monitoring; this view shows and corrects its understanding.
struct FollowingView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @State private var checks: [FollowingCheck]?
    @State private var history = false
    @State private var selected: FollowingCheck?

    private var rows: [FollowingCheck] {
        (checks ?? []).filter { ($0.state != "open") == history }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                DetailTitle(title: "Following")
                    .padding(.horizontal, Tokens.Mobile.Size.margin)
                    .padding(.vertical, Tokens.Space.md)
                Picker("View", selection: $history) {
                    Text("Following").tag(false)
                    Text("History").tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.bottom, Tokens.Space.md)
                ForEach(rows) { check in
                    Button { selected = check } label: {
                        ListRow(check.text, systemImage: "eye", subtitle: subtitle(check))
                    }
                    .buttonStyle(.row)
                }
            }
            .padding(.bottom, Tokens.Space.xxxl)
        }
        .overlay {
            if checks != nil, rows.isEmpty {
                EmptyState(title: history ? "No history" : "Nothing to follow", systemImage: "eye")
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await session.run { try await load() }
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
        .refreshable { await session.run { try await load() } }
        .sheet(item: $selected, onDismiss: reload, content: { check in
            NavigationStack {
                FollowingDetailView(checkID: check.id) { destination in
                    selected = nil
                    open(destination)
                }
            }
        })
        .phoneTabBar()
        .mobileBackground()
        .pushedScreen("Following")
    }

    private func reload() {
        Task { await session.run { try await load() } }
    }

    private func load() async throws {
        guard let workspace = session.workspace else { return }
        checks = try await session.api.following(workspaceID: workspace.id)
    }

    private func subtitle(_ check: FollowingCheck) -> String {
        guard check.explicitTime != 0 else { return check.stateLabel }
        return "\(check.stateLabel) · Stated date · \(Date(milliseconds: check.checkAt).formatted())"
    }
}

private struct FollowingDetailView: View {
    let checkID: String
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var detail: FollowingDetail?
    @State private var quote = ""
    @State private var busy = false

    var body: some View {
        SettingsList {
            if let detail {
                checkCard(detail)
                evidenceCard(detail)
                historyCard(detail)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Following")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .task { await session.run { try await load() } }
        .refreshable { await session.run { try await load() } }
    }

    private func checkCard(_ detail: FollowingDetail) -> some View {
        SettingsCard(title: detail.check.text) {
            SettingsRow("State", description: detail.check.stateLabel) { EmptyView() }
            if detail.check.explicitTime != 0 {
                SettingsRow("Stated date", description: time(detail.check.checkAt)) { EmptyView() }
            }
            if detail.check.state == "open" {
                SettingsRow("Next review", description: time(detail.check.reviewAt)) { EmptyView() }
            }
            SettingsRow("Last change", description: time(detail.check.updatedAt)) { EmptyView() }
            if let threadID = detail.check.threadId {
                Button { open(.thread(threadID)) } label: {
                    ListRow("Open discussion", systemImage: "bubble.left")
                }
                .buttonStyle(.row)
            }
            if detail.check.state == "open" {
                action("Handled", systemImage: "checkmark", change: "handled")
                action("Stop following", systemImage: "stop", change: "stop")
            } else {
                action("Reopen", systemImage: "arrow.clockwise", change: "reopen")
            }
            if detail.history.first?.previous != nil {
                action("Undo last change", systemImage: "arrow.uturn.backward", change: "undo")
            }
            VStack(alignment: .leading, spacing: Tokens.Space.md) {
                Text("Correct").font(.golem(Tokens.Mobile.FontSize.row))
                TextField("Correction", text: $quote, axis: .vertical)
                    .lineLimit(3...8)
                    .font(.golem(Tokens.Mobile.FontSize.row))
                    .disabled(busy)
                Button(busy ? "Saving…" : "Apply correction") { change("correct", quote: quote) }
                    .buttonStyle(.secondary)
                    .disabled(
                        busy || quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || quote.count > 8000
                    )
            }
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.vertical, Tokens.Space.md)
        }
    }

    private func evidenceCard(_ detail: FollowingDetail) -> some View {
        SettingsCard(title: "Evidence") {
            ForEach(detail.evidence) { evidence in
                DisclosureGroup {
                    if let address = evidence.url, let url = URL(string: address), url.scheme == "https" {
                        Link("Open source", destination: url)
                    }
                    Text(evidence.text).textSelection(.enabled)
                    ForEach(Array((evidence.attachments ?? []).enumerated()), id: \.offset) { _, file in
                        Text(file.name)
                    }
                } label: {
                    Text("\(evidence.source) · \(time(evidence.timestamp))")
                }
                .font(.golem(Tokens.Mobile.FontSize.row))
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.vertical, Tokens.Space.md)
            }
        }
    }

    private func historyCard(_ detail: FollowingDetail) -> some View {
        SettingsCard(title: "History") {
            ForEach(detail.history) { revision in
                DisclosureGroup {
                    if let previous = revision.previous { Text("Before · \(previous.state) · \(previous.text)") }
                    Text("After · \(revision.current.state) · \(revision.current.text)")
                    if revision.current.explicitTime != 0 { Text("Stated date · \(time(revision.current.checkAt))") }
                } label: {
                    Text("\(revision.quote ?? "Golem review") · \(time(revision.timestamp))")
                }
                .font(.golem(Tokens.Mobile.FontSize.row))
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.vertical, Tokens.Space.md)
            }
        }
    }

    private func action(_ title: String, systemImage: String, change: String) -> some View {
        Button { self.change(change, quote: title) } label: { ListRow(title, systemImage: systemImage) }
            .buttonStyle(.row)
            .disabled(busy)
    }

    private func change(_ action: String, quote: String) {
        guard let workspace = session.workspace, let check = detail?.check else { return }
        busy = true
        Task {
            await session.run {
                do {
                    detail = try await session.api.changeFollowing(
                        workspaceID: workspace.id, check: check, action: action, quote: quote
                    )
                    self.quote = ""
                } catch {
                    try? await load()
                    throw error
                }
            }
            busy = false
        }
    }

    private func load() async throws {
        guard let workspace = session.workspace else { return }
        detail = try await session.api.followingDetail(workspaceID: workspace.id, checkID: checkID)
    }

    private func time(_ milliseconds: Double) -> String { Date(milliseconds: milliseconds).formatted() }
}
