import SwiftUI

/// A channel's summary, its routines, and their newest runs. People create routines by asking an agent.
struct ChannelDetailsView: View {
    let channelID: String
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var routines: [Routine] = []
    @State private var runs: [RoutineRun] = []
    @State private var loaded = false

    private var channel: Channel? { session.channels.first { $0.id == channelID } }
    private var workspaceID: String { session.workspace?.id ?? "" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.xxxl) {
                if let summary = channel?.summary {
                    VStack(alignment: .leading, spacing: Tokens.Space.lg) {
                        Text("Summary")
                            .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.medium))
                            .foregroundStyle(Tokens.Colors.text)
                            .accessibilityAddTraits(.isHeader)
                        Text(summary)
                            .font(.golem(Tokens.FontSize.md))
                            .foregroundStyle(Tokens.Colors.textSecondary)
                            .lineSpacing(Tokens.FontSize.md * 0.5)
                    }
                }
                if routines.isEmpty {
                    section("Routines") { EmptyState(title: "No routines yet", systemImage: "play") }
                } else {
                    SettingsCard(title: "Routines") {
                        ForEach($routines) { $routine in routineRow($routine) }
                    }
                }
                if runs.isEmpty {
                    section("Runs") { EmptyState(title: "No runs yet", systemImage: "tray") }
                } else {
                    SettingsCard(title: "Runs") {
                        ForEach(runs) { run in
                            SettingsRow(
                                run.routineName,
                                description: [time(run.startedAt), run.error].compactMap { $0 }.joined(separator: " · ")
                            ) {
                                outcomeBadge(run.outcome)
                            }
                        }
                    }
                }
            }
            .opacity(loaded ? 1 : 0)
            .frame(maxWidth: 640)
            .padding(Tokens.Space.xl)
            .frame(maxWidth: .infinity)
        }
        .background(Tokens.Colors.surface)
        .navigationTitle(channel.map { "#\($0.name)" } ?? "")
        .navigationBarTitleDisplayMode(.large)
        .task { await load() }
        .refreshable { await load() }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.lg) {
            Text(title)
                .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.medium))
                .foregroundStyle(Tokens.Colors.text)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func routineRow(_ routine: Binding<Routine>) -> some View {
        let value = routine.wrappedValue
        return SettingsRow(
            value.name, description: value.nextRunAt.map { "Next \(time($0))" } ?? "Paused"
        ) {
            HStack(spacing: Tokens.Space.xs) {
                Toggle(isOn: Binding(get: { value.enabled }, set: { setEnabled(routine, $0) })) {}
                    .toggleStyle(.golemSwitch)
                    .accessibilityLabel("Run \(value.name)")
                GolemMenu {
                    if let threadID = value.threadId {
                        MenuItem("Open thread", systemImage: "square.and.pencil") { open(.thread(threadID)) }
                    }
                    MenuItem("Run now", systemImage: "play") { run(value) }
                    MenuItem("Delete", systemImage: "trash", role: .destructive) { delete(value) }
                } label: {
                    Label("\(value.name) actions", systemImage: "ellipsis")
                }
                .buttonStyle(.golem(.ghost, .icon))
            }
        }
    }

    private func outcomeBadge(_ outcome: RoutineRun.Outcome) -> Badge {
        switch outcome {
        case .running: Badge(label: "Running", tone: .accent)
        case .quiet: Badge(label: "Quiet")
        case .posted: Badge(label: "Posted", tone: .success)
        case .failed: Badge(label: "Failed", tone: .danger)
        }
    }

    private func time(_ milliseconds: Double) -> String {
        Date(milliseconds: milliseconds).formatted(
            .dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute()
        )
    }

    private func load() async {
        await session.run {
            try await session.reloadWorkspace()
            let found = try await session.api.routines(workspaceID: workspaceID, channelID: channelID)
            (routines, runs) = (found.routines, found.runs)
            loaded = true
        }
    }

    private func setEnabled(_ routine: Binding<Routine>, _ enabled: Bool) {
        routine.wrappedValue.enabled = enabled
        let id = routine.wrappedValue.id
        Task {
            await session.run {
                do {
                    routine.wrappedValue = try await session.api.setRoutine(id, enabled: enabled)
                } catch {
                    routine.wrappedValue.enabled = !enabled
                    throw error
                }
            }
        }
    }

    private func run(_ routine: Routine) {
        Task {
            await session.run {
                try await session.api.runRoutine(routine.id)
                session.show("\(routine.name) runs now", .success)
                await load()
            }
        }
    }

    private func delete(_ routine: Routine) {
        Task {
            await session.run {
                try await session.api.deleteRoutine(routine.id)
                routines.removeAll { $0.id == routine.id }
                session.show("\(routine.name) deleted", .success)
            }
        }
    }
}
