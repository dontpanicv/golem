import SwiftUI

/// The machines of a workspace, for every member's turns there, or the person's own for a nil `workspaceID`, for their
/// turns in each of their workspaces. The member who paired a workspace's machine chooses the members whose turns
/// change it without asking.
struct MachinesSection: View {
    let workspaceID: String?
    @Environment(Session.self) private var session
    @State private var machines: [Machine] = []
    @State private var members: [Member] = []
    @State private var pairing: Pairing?

    var body: some View {
        SettingsCard(title: "Machines") {
            ForEach(machines) { machine in
                SettingsRow(machine.name, description: machine.summary) {
                    GolemMenu {
                        let others = members.filter { $0.userId != session.user?.id }
                        if machine.pairedBy == session.user?.id, !others.isEmpty {
                            MenuSectionLabel("Changes without asking")
                            ForEach(others) { member in
                                MenuItem(member.name, checked: machine.trustedMemberIds.contains(member.userId)) {
                                    toggleTrust(member, on: machine)
                                }
                            }
                            MenuSeparator()
                        }
                        MenuItem("Remove machine", systemImage: "trash", role: .destructive) { remove(machine) }
                    } label: {
                        Label("Machine actions", systemImage: "ellipsis")
                    }
                    .buttonStyle(.golem(.ghost, .icon))
                }
            }
            if let pairing {
                PairingCommand(pairing: pairing).padding(Tokens.Space.xl)
            } else {
                HStack {
                    Button("Add machine", systemImage: "plus", action: startPairing)
                        .buttonStyle(.golem(.ghost, .small))
                    Spacer()
                }
                .padding(.horizontal, Tokens.Space.md)
                .padding(.vertical, Tokens.Space.lg)
            }
        }
        .task { await session.run { try await load() } }
        .task(id: pairing) {
            // While a pairing waits, look for the machine every 2 seconds.
            while pairing != nil, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                try? await load()
            }
        }
    }

    private func load() async throws {
        let found = try await session.api.machines(workspaceID: workspaceID)
        (machines, pairing) = (found.machines, found.pairing)
        if let workspaceID {
            members = try await session.api.members(workspaceID: workspaceID)
        }
    }

    private func toggleTrust(_ member: Member, on machine: Machine) {
        guard let workspaceID else { return }
        let trusted = machine.trustedMemberIds.contains(member.userId)
        let userIDs = trusted
            ? machine.trustedMemberIds.filter { $0 != member.userId }
            : machine.trustedMemberIds + [member.userId]
        Task {
            await session.run {
                let changed = try await session.api.trustMembers(
                    workspaceID: workspaceID, machineID: machine.id, userIDs: userIDs
                )
                machines = machines.map { $0.id == changed.id ? changed : $0 }
            }
        }
    }

    private func startPairing() {
        Task {
            await session.run { pairing = try await session.api.startPairing(workspaceID: workspaceID) }
        }
    }

    private func remove(_ machine: Machine) {
        Task {
            await session.run {
                try await session.api.removeMachine(workspaceID: workspaceID, machineID: machine.id)
                machines.removeAll { $0.id == machine.id }
            }
        }
    }
}

/// The command that installs hands on a machine and pairs it with the workspace or the person.
private struct PairingCommand: View {
    let pairing: Pairing
    @Environment(Session.self) private var session

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.lg) {
            Text("Run this on the Mac or Linux computer within 10 minutes")
                .font(.golem(Tokens.FontSize.sm, Tokens.FontWeight.book))
                .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
            Text(pairing.command)
                .font(.system(size: Tokens.FontSize.sm, design: .monospaced))
                .foregroundStyle(Tokens.Mobile.Colors.text)
                .textSelection(.enabled)
            Button("Copy command") {
                UIPasteboard.general.string = pairing.command
                session.show("Copied", .success)
            }
            .buttonStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
