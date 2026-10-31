import SwiftUI

/// What Golem runs for the person and what waits for them, soonest first: what needs them, what Golem suggests, the
/// routines and reminders by day, and the paused routines. Routines pause and resume here; reminders cancel here.
struct UpcomingView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var upcoming: Upcoming?

    private var groups: [UpcomingGroup] { upcoming?.groups() ?? [] }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(groups) { group in
                    if group.id != groups.first?.id { ListSeparator() }
                    ListSectionHeader(title: group.kind.rawValue)
                    ForEach(group.items) { row($0, in: group.kind) }
                }
            }
            .padding(.bottom, Tokens.Space.xxxl)
            .animation(.snappy, value: groups)
        }
        .overlay {
            if upcoming != nil, groups.isEmpty { EmptyState(title: "Nothing upcoming", systemImage: "calendar") }
        }
        // Approvals come and go as agents work.
        .task(id: session.working) { await session.run { try await load() } }
        .refreshable { await session.run { try await load() } }
        .phoneTabBar()
        .mobileBackground()
        .screenTitle("Upcoming")
    }

    private func load() async throws {
        guard let workspace = session.workspace else { return }
        upcoming = try await session.api.upcoming(workspaceID: workspace.id)
    }

    @ViewBuilder
    private func row(_ item: UpcomingItem, in kind: UpcomingGroup.Kind) -> some View {
        switch item {
        case let .approval(threadID, approval):
            Button { open(.thread(threadID)) } label: {
                ListRow(approval.text, systemImage: "hand.raised", subtitle: threadTitle(threadID))
            }
            .buttonStyle(.row)
        case let .routine(routine):
            actionRow {
                open(routine.threadId.map { .thread($0) } ?? .channel(routine.channelId))
            } label: {
                ListRow(routine.name, systemImage: "arrow.clockwise", subtitle: subtitle(routine, kind))
            } actions: {
                MenuItem(
                    routine.enabled ? "Pause routine" : "Resume routine",
                    systemImage: routine.enabled ? "pause" : "play"
                ) { setEnabled(routine, !routine.enabled) }
            }
        case let .reminder(reminder):
            actionRow { open(.thread(reminder.threadId)) } label: {
                ListRow(reminder.text, systemImage: "bell", subtitle: when(reminder.dueAt, kind))
            } actions: {
                MenuItem("Cancel reminder", systemImage: "xmark", role: .destructive) { cancel(reminder) }
            }
        case let .suggestion(suggestion):
            SuggestionCard(suggestion: suggestion) {
                upcoming?.suggestions.removeAll { $0.id == suggestion.id }
                Task { try? await load() }
            }
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.vertical, Tokens.Space.xs)
        }
    }

    /// A row that opens something, with its actions in a menu at the end, beside the row and not in it.
    private func actionRow<RowLabel: View, Actions: View>(
        open: @escaping () -> Void, @ViewBuilder label: () -> RowLabel, @ViewBuilder actions: () -> Actions
    ) -> some View {
        HStack(spacing: 0) {
            Button(action: open, label: label).buttonStyle(.row)
            GolemMenu(content: actions) {
                Label("Actions", systemImage: "ellipsis")
            }
            .buttonStyle(.golem(.ghost, .icon))
            .padding(.trailing, Tokens.Mobile.Size.margin)
        }
    }

    private func subtitle(_ routine: Routine, _ kind: UpcomingGroup.Kind) -> String {
        let channel = session.channels.first { $0.id == routine.channelId }.map { "#\($0.name)" }
        let detail: String? = switch kind {
        case .needsYou: routine.lastRun?.error ?? "Failed"
        case .paused: "Paused"
        default: routine.nextRunAt.map { when($0, kind) }
        }
        return [channel, detail].compactMap { $0 }.joined(separator: " · ")
    }

    /// The time alone today and tomorrow, which the group names; the day too after that.
    private func when(_ milliseconds: Double, _ kind: UpcomingGroup.Kind) -> String {
        let date = Date(milliseconds: milliseconds)
        if kind == .today || kind == .tomorrow { return date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
    }

    private func threadTitle(_ threadID: String) -> String? {
        if threadID == session.orchestrator?.id { return "Golem" }
        return session.channels.flatMap(\.threads).first { $0.id == threadID }?.title
    }

    private func setEnabled(_ routine: Routine, _ enabled: Bool) {
        Task {
            await session.run {
                let changed = try await session.api.setRoutine(routine.id, enabled: enabled)
                upcoming?.routines = upcoming?.routines.map { $0.id == changed.id ? changed : $0 } ?? []
            }
        }
    }

    private func cancel(_ reminder: Reminder) {
        guard let workspace = session.workspace else { return }
        Task {
            await session.run {
                try await session.api.cancelReminder(workspaceID: workspace.id, reminderID: reminder.id)
                upcoming?.reminders.removeAll { $0.id == reminder.id }
            }
        }
    }
}

/// A routine or a reminder that Golem suggests, with Decline and Accept. `answered` takes it away.
struct SuggestionCard: View {
    let suggestion: Suggestion
    let answered: () -> Void
    @Environment(Session.self) private var session
    @State private var busy = false

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(suggestion.name)
                    .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium))
                    .foregroundStyle(Tokens.Mobile.Colors.text)
                    .lineLimit(2)
                Text(detail)
                    .font(.golem(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Decline") { answer(false) }
                .buttonStyle(.golem(.secondary, .small))
            Button("Accept") { answer(true) }
                .buttonStyle(.golem(.primary, .small))
        }
        .disabled(busy)
        .padding(Tokens.Space.lg)
        .raisedCard(ring: Tokens.Colors.ringControl)
    }

    /// "Routine · Mon 3 Nov, 08:00", or the schedule without a first run.
    private var detail: String {
        let kind = suggestion.kind == .routine ? "Routine" : "Reminder"
        let time = suggestion.time.map {
            Date(milliseconds: $0).formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
        } ?? suggestion.schedule
        return [kind, time].compactMap { $0 }.joined(separator: " · ")
    }

    private func answer(_ accept: Bool) {
        guard let workspace = session.workspace else { return }
        busy = true
        Task {
            await session.run {
                try await session.api.answerSuggestion(
                    workspaceID: workspace.id, suggestionID: suggestion.id, accept: accept
                )
                if accept { session.show(suggestion.kind == .routine ? "Routine added" : "Reminder set", .success) }
                answered()
            }
            busy = false
        }
    }
}

/// A group of Upcoming, in the order of `Kind`.
struct UpcomingGroup: Identifiable, Hashable {
    enum Kind: String, CaseIterable {
        case needsYou = "Needs you"
        case suggested = "Suggested"
        case today = "Today"
        case tomorrow = "Tomorrow"
        case thisWeek = "This week"
        case later = "Later"
        case paused = "Paused"
    }

    let kind: Kind
    let items: [UpcomingItem]
    var id: Kind { kind }
}

enum UpcomingItem: Hashable, Identifiable {
    case approval(threadID: String, Approval)
    case routine(Routine)
    case reminder(Reminder)
    case suggestion(Suggestion)

    var id: String {
        switch self {
        case let .approval(_, approval): "approval:\(approval.id)"
        case let .routine(routine): "routine:\(routine.id)"
        case let .reminder(reminder): "reminder:\(reminder.id)"
        case let .suggestion(suggestion): "suggestion:\(suggestion.id)"
        }
    }
}

extension Upcoming {
    /// The groups that have items: approvals and failed routines need the person; routines by their next run and
    /// reminders by their time go under the day, soonest first ("This week" is the 5 days after tomorrow); paused
    /// routines go last.
    func groups(now: Date = .now, calendar: Calendar = .current) -> [UpcomingGroup] {
        var needsYou = approvals.map { UpcomingItem.approval(threadID: $0.threadId, $0.approval) }
        var paused: [UpcomingItem] = []
        var timed: [(time: Double, item: UpcomingItem)] = reminders.map { ($0.dueAt, .reminder($0)) }
        for routine in routines {
            if !routine.enabled {
                paused.append(.routine(routine))
            } else if routine.lastRun?.outcome == .failed {
                needsYou.append(.routine(routine))
            } else {
                timed.append((routine.nextRunAt ?? .infinity, .routine(routine)))
            }
        }
        var items: [UpcomingGroup.Kind: [UpcomingItem]] = [
            .needsYou: needsYou, .suggested: suggestions.map { .suggestion($0) }, .paused: paused
        ]
        let today = calendar.startOfDay(for: now)
        for (time, item) in timed.sorted(by: { $0.time < $1.time }) {
            let days = time.isFinite
                ? calendar.dateComponents([.day], from: today, to: Date(milliseconds: time)).day ?? 0 : .max
            let kind: UpcomingGroup.Kind = switch days {
            case ..<1: .today
            case 1: .tomorrow
            case 2..<7: .thisWeek
            default: .later
            }
            items[kind, default: []].append(item)
        }
        return UpcomingGroup.Kind.allCases.compactMap { kind in
            items[kind].flatMap { $0.isEmpty ? nil : UpcomingGroup(kind: kind, items: $0) }
        }
    }
}
