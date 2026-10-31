import SwiftUI

/// The person's own machines, which they share with every member's turns or keep private, and the ones other members
/// shared.
struct MachinesSection: View {
    let workspaceID: String
    @Environment(Session.self) private var session
    @State private var machines: [Machine] = []
    @State private var pairing: Pairing?

    var body: some View {
        SettingsCard(title: "Machines") {
            ForEach($machines) { $machine in
                if machine.pairedBy == session.user?.id {
                    let visibility = machine.shared ? "Shared" : "Private"
                    SettingsRow(machine.name, description: "\(machine.summary) · \(visibility)") {
                        Toggle("Private", isOn: Binding(get: { !machine.shared }, set: { share($machine, !$0) }))
                            .labelsHidden()
                        GolemMenu {
                            MenuItem("Remove machine", systemImage: "trash", role: .destructive) { remove(machine) }
                        } label: {
                            Label("Machine actions", systemImage: "ellipsis")
                        }
                        .buttonStyle(.golem(.ghost, .icon))
                    }
                } else {
                    SettingsRow(machine.name, description: "\(machine.summary) · Shared by \(machine.pairedByName)")
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
    }

    private func startPairing() {
        Task {
            await session.run { pairing = try await session.api.startPairing(workspaceID: workspaceID) }
        }
    }

    private func share(_ machine: Binding<Machine>, _ shared: Bool) {
        Task {
            await session.run {
                machine.wrappedValue = try await session.api.setMachineShared(
                    workspaceID: workspaceID, machineID: machine.wrappedValue.id, shared: shared
                )
            }
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

/// The command that installs hands on a machine and pairs it with the person.
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
