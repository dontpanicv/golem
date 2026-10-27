import SwiftUI

/// The name, members, machines, and integrations of the open workspace; only an owner renames or deletes it.
struct WorkspaceSettingsView: View {
    @Environment(Session.self) private var session
    @State private var members: [Member] = []
    @State private var machines: [Machine] = []
    @State private var pairing: Pairing?
    @State private var email = ""
    @State private var name = ""
    @State private var confirmDelete = false

    private var workspaceID: String { session.workspace?.id ?? "" }
    private var renamed: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && name != session.workspace?.name
    }

    var body: some View {
        SettingsList {
            if session.workspace?.role == "owner" {
                SettingsCard(title: "Workspace") {
                    HStack(spacing: Tokens.Space.md) {
                        GolemTextField(nil, placeholder: "Name", text: $name)
                            .onSubmit(rename)
                            .accessibilityLabel("Name")
                        Button("Save", action: rename)
                            .buttonStyle(.secondary)
                            .disabled(!renamed)
                    }
                    .padding(Tokens.Space.xl)
                    SettingsRow("Delete workspace") {
                        Button("Delete") { confirmDelete = true }
                            .buttonStyle(.golem(.danger, .small))
                    }
                }
            }
            SettingsCard(title: "Members") {
                ForEach(members) { member in
                    SettingsRow(label: member.name, description: member.email) {
                        Avatar(name: member.name, size: 32)
                    } control: {
                        Badge(label: member.role.capitalized)
                    }
                }
                if session.workspace?.role == "owner" {
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
            IntegrationsSection(workspaceID: workspaceID)
        }
        .phoneTabBar()
        .screenTitle(session.workspace?.name ?? "")
        .task { await load() }
        .onAppear { name = session.workspace?.name ?? "" }
        .refreshable { await load() }
        .task(id: pairing) {
            // While a pairing waits, look for the machine every 2 seconds.
            while pairing != nil, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await loadMachines()
            }
        }
        .sheet(isPresented: $confirmDelete) {
            DeleteDialog(
                title: "Delete \(session.workspace?.name ?? "")?",
                message: "Its channels, threads, files, artifacts, and routines go with it.",
                submit: "Delete workspace"
            ) {
                try await session.deleteWorkspace()
            }
        }
    }

    private func load() async {
        await session.run {
            async let members = session.api.members(workspaceID: workspaceID)
            async let machines = session.api.machines(workspaceID: workspaceID)
            let found: Machines
            (self.members, found) = try await (members, machines)
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

    private func rename() {
        let name = name
        guard renamed else { return }
        Task {
            await session.run {
                try await session.renameWorkspace(name: name)
                session.show("Saved", .success)
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
