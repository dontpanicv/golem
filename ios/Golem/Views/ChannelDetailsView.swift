import SwiftUI

/// A channel's name, its summary and brief, its routines, and their newest runs. People create routines by asking an
/// agent; the model writes the summary and the brief from the channel's threads.
struct ChannelDetailsView: View {
    let channelID: String
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var routines: [Routine] = []
    @State private var runs: [RoutineRun] = []
    @State private var brief: Brief?
    @State private var loaded = false
    @State private var name = ""
    @State private var opening: FileRef?

    private var channel: Channel? { session.channels.first { $0.id == channelID } }
    private var workspaceID: String { session.workspace?.id ?? "" }
    private var renamed: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && name != channel?.name
    }

    var body: some View {
        SettingsList {
            DetailTitle(title: channel.map { "# \($0.name)" } ?? "", caption: "Channel details")
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.vertical, Tokens.Space.md)
            SettingsCard(title: "Channel") {
                HStack(spacing: Tokens.Space.md) {
                    GolemTextField(nil, placeholder: "Name", text: $name)
                        .textInputAutocapitalization(.never)
                        .onSubmit(rename)
                        .accessibilityLabel("Name")
                    Button("Save", action: rename)
                        .buttonStyle(.secondary)
                        .disabled(!renamed)
                }
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.bottom, Tokens.Space.lg)
            }
            if let summary = channel?.summary {
                SettingsCard(title: "Summary") {
                    Text(summary)
                        .font(.golem(Tokens.Mobile.FontSize.row))
                        .foregroundStyle(Tokens.Mobile.Colors.text)
                        .lineSpacing(4)
                        .padding(.horizontal, Tokens.Mobile.Size.margin)
                        .padding(.vertical, Tokens.Space.sm)
                }
            }
            if let brief {
                SettingsCard(title: "Brief") {
                    MarkdownText(text: brief.text, size: Tokens.Mobile.FontSize.row)
                        .foregroundStyle(Tokens.Mobile.Colors.text)
                        .lineSpacing(4)
                        .copyable(brief.text)
                        .padding(.horizontal, Tokens.Mobile.Size.margin)
                        .padding(.vertical, Tokens.Space.sm)
                }
            }
            if routines.isEmpty {
                SettingsCard(title: "Routines") {
                    SettingsRow("No routines yet", labelColor: Tokens.Mobile.Colors.textTertiary) { EmptyView() }
                }
            } else {
                SettingsCard(title: "Routines") {
                    ForEach($routines) { $routine in routineRow($routine) }
                }
            }
            if runs.isEmpty {
                SettingsCard(title: "Runs") {
                    SettingsRow("No runs yet", labelColor: Tokens.Mobile.Colors.textTertiary) { EmptyView() }
                }
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
        .phoneTabBar()
        .pushedScreen(channel.map { "#\($0.name)" } ?? "")
        .task { await load() }
        .onAppear { name = channel?.name ?? "" }
        .refreshable { await load() }
        .filePreview($opening)
        // The brief's links open here instead of leaving the app, as a thread's do.
        .environment(\.openURL, OpenURLAction { url in
            guard let scheme = url.scheme, ["thread", "file", "artifact"].contains(scheme) else {
                return .systemAction
            }
            let id = String(url.absoluteString.dropFirst(scheme.count + 1))
            switch scheme {
            case "thread": open(.thread(id))
            case "file": opening = FileRef(id: id, name: "")
            default: open(.artifact(channel: channelID, artifact: id))
            }
            return .handled
        })
    }

    private func routineRow(_ routine: Binding<Routine>) -> some View {
        let value = routine.wrappedValue
        return SettingsRow(
            value.name,
            description: value.nextRunAt.map { "Next \(time($0))" } ?? (value.enabled ? value.place?.summary : nil)
                ?? "Paused"
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
            brief = try await session.api.brief(workspaceID: workspaceID, channelID: channelID)
            loaded = true
        }
    }

    private func rename() {
        let name = name
        guard renamed else { return }
        Task {
            await session.run {
                try await session.renameChannel(channelID: channelID, name: name)
                self.name = channel?.name ?? name
                session.show("Saved", .success)
            }
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
