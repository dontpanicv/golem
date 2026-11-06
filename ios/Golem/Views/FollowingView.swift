import SwiftUI

/// All that Golem holds for the person from the accounts it reads: the thread updates that wait, the matters it
/// follows, its sources, what it keeps, and what it did. Each row opens its detail, where the person gives feedback.
struct FollowingView: View {
    let open: (Destination) -> Void
    /// Shown inside Agenda, which gives the title.
    var embedded = false
    @Environment(Session.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @State private var checks: [FollowingCheck]?
    @State private var overview: FollowingOverview?
    @State private var query = ""
    @State private var allKept = false
    @State private var selected: Selected?
    @State private var unblocking: IntakeBlock?

    /// The kept observations that show before "Show all".
    private let keptRows = 15

    enum Selected: Identifiable {
        case check(FollowingCheck), update(IntakeUpdate), kept(IntakeKept), source(IntakeSource)

        var id: String {
            switch self {
            case let .check(check): "check:\(check.id)"
            case let .update(update): "update:\(update.id)"
            case let .kept(item): "item:\(item.id)"
            case let .source(source): "source:\(source.id)"
            }
        }
    }

    private var waiting: [IntakeUpdate] { (overview?.updates ?? []).filter(\.waits) }
    private var following: [FollowingCheck] { (checks ?? []).filter { $0.state == "open" } }
    private var done: [(at: Double, row: Selected)] {
        let updates = (overview?.updates ?? []).filter { !$0.waits }
            .map { (at: $0.deliveredAt ?? $0.cancelledAt ?? $0.createdAt, row: Selected.update($0)) }
        let closed = (checks ?? []).filter { $0.state != "open" }.map { (at: $0.updatedAt, row: Selected.check($0)) }
        return (updates + closed).sorted { $0.at > $1.at }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if !embedded {
                    DetailTitle(title: "Following")
                        .padding(.horizontal, Tokens.Mobile.Size.margin)
                        .padding(.vertical, Tokens.Space.md)
                }
                section("Waiting", waiting.map(Selected.update))
                section("Following", following.map(Selected.check))
                section("Sources", (overview?.sources ?? []).map(Selected.source))
                if let blocked = overview?.blocked, !blocked.isEmpty {
                    ListSeparator()
                    ListSectionHeader(title: "Blocked")
                    ForEach(blocked) { block in
                        Button { unblocking = block } label: {
                            ListRow(
                                block.label, systemImage: "nosign",
                                subtitle: block.kind == "sender" ? "Sender" : "Chat"
                            )
                        }
                        .buttonStyle(.row)
                    }
                }
                if let overview, !overview.sources.isEmpty { keptSection(overview.kept) }
                section("Done", done.map(\.row))
                if let feedback = overview?.feedback, !feedback.isEmpty {
                    ListSeparator()
                    ListSectionHeader(title: "Your feedback")
                    ForEach(feedback) { each in
                        ListRow(each.quote, systemImage: "text.bubble", subtitle: each.about)
                    }
                }
            }
            .padding(.bottom, Tokens.Space.xxxl)
        }
        .overlay {
            if let overview, overview.sources.isEmpty {
                EmptyState(title: "Golem reads no account for you", systemImage: "tray")
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await session.run { try await load() }
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
        .task(id: query) {
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await session.run { try await load() }
        }
        .refreshable { await session.run { try await load() } }
        .confirmationDialog(
            "Unblock \(unblocking?.label ?? "")?",
            isPresented: Binding { unblocking != nil } set: { if !$0 { unblocking = nil } },
            titleVisibility: .visible,
            presenting: unblocking
        ) { block in
            Button("Unblock") { unblock(block) }
        } message: { _ in
            Text("Golem reads new messages from it again.")
        }
        .sheet(item: $selected, onDismiss: reload) { selection in
            NavigationStack { detail(selection) }
        }
        .phoneTabBar()
        .mobileBackground()
        .pushedScreen(embedded ? nil : "Following")
    }

    @ViewBuilder
    private func section(_ title: String, _ rows: [Selected]) -> some View {
        if !rows.isEmpty {
            ListSeparator()
            ListSectionHeader(title: title)
            ForEach(rows) { row in
                Button { selected = row } label: { label(row) }
                    .buttonStyle(.row)
            }
        }
    }

    @ViewBuilder
    private func keptSection(_ kept: [IntakeKept]) -> some View {
        ListSeparator()
        ListSectionHeader(title: "Kept")
        TextField("Search mail, messages, and notes", text: $query)
            .textFieldStyle(.roundedBorder)
            .font(.golem(Tokens.Mobile.FontSize.row))
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.vertical, Tokens.Space.md)
        ForEach(allKept ? kept : Array(kept.prefix(keptRows))) { item in
            Button { selected = .kept(item) } label: { label(.kept(item)) }
                .buttonStyle(.row)
        }
        if !allKept, kept.count > keptRows {
            Button("Show all \(kept.count)") { allKept = true }
                .buttonStyle(.secondary)
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.vertical, Tokens.Space.md)
        }
    }

    @ViewBuilder
    private func label(_ row: Selected) -> some View {
        switch row {
        case let .update(update):
            ListRow(
                update.title, systemImage: update.deliveredAt == nil ? "clock" : "checkmark",
                subtitle: "\(update.state) · \(update.message)"
            )
        case let .check(check):
            ListRow(
                check.text, systemImage: check.state == "open" ? "eye" : "checkmark", subtitle: checkState(check)
            )
        case let .source(source):
            ListRow(title: source.name, systemImage: "tray", subtitle: source.error ?? source.state) {
                if source.error != nil { Badge(label: "Error", tone: .danger) }
            }
        case let .kept(item):
            ListRow(
                title: item.evidence.name, systemImage: item.fromOwner ? "arrow.up" : "tray",
                subtitle: "\(Date(milliseconds: item.timestamp).formatted()) · \(item.text)"
            ) {
                Badge(label: item.badge, tone: item.outcome == "context" ? .neutral : .success)
            }
        }
    }

    @ViewBuilder
    private func detail(_ selection: Selected) -> some View {
        let leave: (Destination) -> Void = { destination in
            selected = nil
            open(destination)
        }
        let earlier = (overview?.feedback ?? []).filter { $0.target == selection.id }
        switch selection {
        case let .check(check):
            FollowingDetailView(checkID: check.id, open: leave)
        case let .update(update):
            UpdateDetailView(update: update, earlier: earlier, open: leave)
        case let .kept(item):
            IntakeDetailView(title: item.evidence.name, target: selection.id, earlier: earlier) {
                SettingsCard {
                    SettingsRow(Date(milliseconds: item.timestamp).formatted(), description: item.location)
                    DetailText(text: item.text)
                    if let threadID = item.threadId {
                        Button { leave(.thread(threadID)) } label: {
                            ListRow("Open thread", systemImage: "bubble.left")
                        }
                        .buttonStyle(.row)
                    }
                    SourceLink(url: item.url)
                }
            }
        case let .source(source):
            IntakeDetailView(title: source.name, target: selection.id, earlier: earlier) {
                SettingsCard {
                    SettingsRow(source.state, description: source.error)
                }
            }
        }
    }

    private func unblock(_ block: IntakeBlock) {
        guard let workspace = session.workspace else { return }
        Task {
            await session.run {
                try await session.api.unblock(workspaceID: workspace.id, blockID: block.id)
                try await load()
            }
        }
    }

    private func reload() {
        Task { await session.run { try await load() } }
    }

    private func load() async throws {
        guard let workspace = session.workspace else { return }
        async let checks = session.api.following(workspaceID: workspace.id)
        async let overview = session.api.followingOverview(workspaceID: workspace.id, query: query)
        (self.checks, self.overview) = try await (checks, overview)
    }

    private func checkState(_ check: FollowingCheck) -> String {
        if check.state != "open" {
            return "\(check.stateLabel) · \(Date(milliseconds: check.updatedAt).formatted())"
        }
        return check.explicitTime != 0
            ? "Due \(Date(milliseconds: check.checkAt).formatted())"
            : "Next look \(Date(milliseconds: check.reviewAt).formatted())"
    }
}
