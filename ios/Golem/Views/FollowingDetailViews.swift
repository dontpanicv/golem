import SwiftUI

/// A waiting or done thread update: what Golem will post, its sources, and Send now or Don't send.
struct UpdateDetailView: View {
    let update: IntakeUpdate
    let earlier: [IntakeFeedback]
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var current: IntakeUpdate?
    @State private var busy = false

    var body: some View {
        let update = current ?? update
        IntakeDetailView(title: update.title, target: "update:\(update.id)", earlier: earlier) {
            SettingsCard {
                SettingsRow(update.state, description: update.notice.map { "Golem will also notify you: \($0)" })
                DetailText(text: update.message)
                if update.waits {
                    if update.attention == "brief" { action("Send now", systemImage: "paperplane", change: "now") }
                    action("Don't send", systemImage: "xmark", change: "cancel")
                }
                if let threadID = update.threadId {
                    Button { open(.thread(threadID)) } label: { ListRow("Open thread", systemImage: "bubble.left") }
                        .buttonStyle(.row)
                }
            }
            SourcesCard(evidence: update.evidence)
        }
    }

    private func action(_ title: String, systemImage: String, change: String) -> some View {
        Button {
            guard let workspace = session.workspace else { return }
            busy = true
            Task {
                await session.run {
                    current = try await session.api.changeUpdate(
                        workspaceID: workspace.id, updateID: update.id, action: change
                    )
                }
                busy = false
            }
        } label: { ListRow(title, systemImage: systemImage) }
            .buttonStyle(.row)
            .disabled(busy)
    }
}

/// The detail of one thing that intake holds, then the person's earlier feedback on it and a field for more.
struct IntakeDetailView<Content: View>: View {
    let title: String
    let target: String
    let earlier: [IntakeFeedback]
    @ViewBuilder let content: Content
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var quote = ""
    @State private var busy = false

    var body: some View {
        SettingsList {
            content
            SettingsCard(title: "Feedback") {
                ForEach(earlier) { each in
                    SettingsRow(
                        each.quote, description: "You said \(Date(milliseconds: each.createdAt).formatted())"
                    )
                }
                VStack(alignment: .leading, spacing: Tokens.Space.md) {
                    TextField("What should Golem do differently?", text: $quote, axis: .vertical)
                        .lineLimit(3...8)
                        .font(.golem(Tokens.Mobile.FontSize.row))
                        .disabled(busy)
                    Button(busy ? "Sending…" : "Send feedback") { send() }
                        .buttonStyle(.secondary)
                        .disabled(busy || quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.vertical, Tokens.Space.md)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
    }

    private func send() {
        guard let workspace = session.workspace else { return }
        busy = true
        Task {
            await session.run {
                _ = try await session.api.sendFeedback(workspaceID: workspace.id, target: target, quote: quote)
                dismiss()
            }
            busy = false
        }
    }
}

/// The source observations behind an update or a check, each opened in place.
struct SourcesCard: View {
    let evidence: [FollowingEvidence]

    var body: some View {
        SettingsCard(title: "Sources") {
            ForEach(evidence) { each in
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: Tokens.Space.md) {
                        Text(each.text).textSelection(.enabled)
                        ForEach(Array((each.attachments ?? []).enumerated()), id: \.offset) { _, file in
                            Text(file.name).foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                        }
                        SourceLink(url: each.url)
                    }
                } label: {
                    Text("\(each.name) · \(Date(milliseconds: each.timestamp).formatted())")
                }
                .font(.golem(Tokens.Mobile.FontSize.row))
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.vertical, Tokens.Space.md)
            }
        }
    }
}

struct DetailText: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.golem(Tokens.Mobile.FontSize.row))
            .foregroundStyle(Tokens.Mobile.Colors.text)
            .textSelection(.enabled)
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.vertical, Tokens.Space.md)
    }
}

struct SourceLink: View {
    let url: String?

    var body: some View {
        if let url, let address = URL(string: url), address.scheme == "https" {
            Link(destination: address) { ListRow("Open source", systemImage: "arrow.up.right") }
                .buttonStyle(.row)
        }
    }
}

/// One followed matter: its state, its actions, its sources and history, and a correction in the person's words.
struct FollowingDetailView: View {
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
                SourcesCard(evidence: detail.evidence)
                historyCard(detail)
                correctionCard
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
        SettingsCard {
            DetailText(text: detail.check.text)
            if detail.check.explicitTime != 0 {
                SettingsRow("Due", description: time(detail.check.checkAt))
            } else if detail.check.state == "open" {
                SettingsRow("Next look", description: time(detail.check.reviewAt))
            } else {
                SettingsRow(detail.check.stateLabel, description: time(detail.check.updatedAt))
            }
            if detail.check.state == "open" {
                action("Handled", systemImage: "checkmark", change: "handled")
                action("Stop following", systemImage: "stop", change: "stop")
            } else {
                action("Follow again", systemImage: "arrow.clockwise", change: "reopen")
            }
            if detail.history.first?.previous != nil {
                action("Undo last change", systemImage: "arrow.uturn.backward", change: "undo")
            }
            if let threadID = detail.check.threadId {
                Button { open(.thread(threadID)) } label: { ListRow("Open thread", systemImage: "bubble.left") }
                    .buttonStyle(.row)
            }
        }
    }

    private func historyCard(_ detail: FollowingDetail) -> some View {
        SettingsCard(title: "History") {
            ForEach(detail.history) { revision in
                SettingsRow(
                    revision.quote ?? "Golem review",
                    description: "\(time(revision.timestamp)) · \(revision.current.text)"
                )
            }
        }
    }

    private var correctionCard: some View {
        SettingsCard(title: "Correction") {
            VStack(alignment: .leading, spacing: Tokens.Space.md) {
                TextField("What is still open, or what is wrong?", text: $quote, axis: .vertical)
                    .lineLimit(3...8)
                    .font(.golem(Tokens.Mobile.FontSize.row))
                    .disabled(busy)
                Button(busy ? "Saving…" : "Correct") { change("correct", quote: quote) }
                    .buttonStyle(.secondary)
                    .disabled(
                        busy || quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || quote.count > 8000
                    )
            }
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.vertical, Tokens.Space.md)
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
