import SwiftUI

/// Members, machines, and integrations of the open workspace.
struct WorkspaceSettingsView: View {
    @Environment(Session.self) private var session
    @State private var members: [Member] = []
    @State private var machines: [Machine] = []
    @State private var pairing: Pairing?
    @State private var integrations: [Integration] = []
    @State private var email = ""
    @State private var addingTo: Integration?

    private var workspaceID: String { session.workspace?.id ?? "" }

    var body: some View {
        SettingsList {
            SettingsCard(title: "Members") {
                ForEach(members) { member in
                    SettingsRow(label: member.name, description: member.email) {
                        Avatar(name: member.name, size: 32)
                    } control: {
                        Badge(label: member.role.capitalized)
                    }
                }
                HStack(spacing: Tokens.Space.md) {
                    GolemTextField(nil, placeholder: "Email address", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(addMember)
                        .accessibilityLabel("Email")
                    Button("Add", action: addMember)
                        .buttonStyle(.secondary)
                        .disabled(email.isEmpty)
                }
                .padding(Tokens.Space.xl)
            }
            SettingsCard(title: "Machines") {
                ForEach(machines) { machine in
                    SettingsRow(machine.name, description: machine.summary) {
                        GolemMenu {
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
            ForEach($integrations) { $integration in
                SettingsCard(title: integration.name) {
                    ForEach(integration.credentials) { credential in
                        SettingsRow(credential.label, description: "Added by \(credential.ownerName)") {
                            GolemMenu {
                                MenuItem("Delete credential", systemImage: "trash", role: .destructive) {
                                    delete(credential, from: $integration)
                                }
                            } label: {
                                Label("Credential actions", systemImage: "ellipsis")
                            }
                            .buttonStyle(.golem(.ghost, .icon))
                        }
                    }
                    HStack {
                        Button("Add credential", systemImage: "plus") { addingTo = integration }
                            .buttonStyle(.golem(.ghost, .small))
                        Spacer()
                    }
                    .padding(.horizontal, Tokens.Space.md)
                    .padding(.vertical, Tokens.Space.lg)
                }
            }
        }
        .phoneTabBar()
        .screenTitle(session.workspace?.name ?? "")
        .task { await load() }
        .refreshable { await load() }
        .task(id: pairing) {
            // While a pairing waits, look for the machine every 2 seconds.
            while pairing != nil, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await loadMachines()
            }
        }
        .sheet(item: $addingTo) { integration in
            CredentialForm(workspaceID: workspaceID, integration: integration) { credential in
                if let index = integrations.firstIndex(where: { $0.id == integration.id }) {
                    integrations[index].credentials.append(credential)
                }
            }
        }
    }

    private func load() async {
        await session.run {
            async let members = session.api.members(workspaceID: workspaceID)
            async let machines = session.api.machines(workspaceID: workspaceID)
            async let integrations = session.api.integrations(workspaceID: workspaceID)
            let found: Machines
            (self.members, found, self.integrations) = try await (members, machines, integrations)
            (self.machines, self.pairing) = (found.machines, found.pairing)
        }
    }

    private func loadMachines() async {
        guard let found = try? await session.api.machines(workspaceID: workspaceID) else { return }
        (machines, pairing) = (found.machines, found.pairing)
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

    private func addMember() {
        let email = email
        guard !email.isEmpty else { return }
        Task {
            await session.run {
                let member = try await session.api.addMember(workspaceID: workspaceID, email: email)
                members.append(member)
                self.email = ""
                session.show("Added \(member.name)", .success)
            }
        }
    }

    private func delete(_ credential: Credential, from integration: Binding<Integration>) {
        Task {
            await session.run {
                try await session.api.deleteCredential(workspaceID: workspaceID, credentialID: credential.id)
                integration.wrappedValue.credentials.removeAll { $0.id == credential.id }
            }
        }
    }
}

/// The command that installs hands on a machine and pairs it with the workspace.
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

private struct CredentialForm: View {
    let workspaceID: String
    let integration: Integration
    let added: (Credential) -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var secret = ""
    @State private var busy = false

    var body: some View {
        Dialog(title: "Add \(integration.name) credential") {
            GolemTextField("Label", text: $label, autofocus: true)
            GolemTextField(integration.secretLabel, text: $secret, secure: true)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button("Add", action: save)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy || label.isEmpty || secret.isEmpty)
        }
    }

    private func save() {
        busy = true
        Task {
            await session.run {
                added(try await session.api.addCredential(
                    workspaceID: workspaceID, integrationID: integration.id,
                    label: label, secret: secret
                ))
                session.show("Credential added", .success)
                dismiss()
            }
            busy = false
        }
    }
}
