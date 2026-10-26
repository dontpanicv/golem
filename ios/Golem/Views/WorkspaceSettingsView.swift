import SwiftUI

/// The name, members, machines, and integrations of the open workspace; only an owner renames or deletes it.
struct WorkspaceSettingsView: View {
    @Environment(Session.self) private var session
    @State private var members: [Member] = []
    @State private var machines: [Machine] = []
    @State private var pairing: Pairing?
    @State private var integrations: [Integration] = []
    @State private var email = ""
    @State private var addingTo: Integration?
    @State private var signingIn: SignIn?
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
                        if integration.secretLabel == nil {
                            Button("Connect", systemImage: "link") { connect(integration) }
                                .buttonStyle(.golem(.ghost, .small))
                        } else {
                            Button("Add credential", systemImage: "plus") { addingTo = integration }
                                .buttonStyle(.golem(.ghost, .small))
                        }
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
        .sheet(item: $signingIn) { signIn in
            SignInForm(workspaceID: workspaceID, signIn: signIn) { credential in
                if let index = integrations.firstIndex(where: { $0.id == signIn.integration.id }) {
                    integrations[index].credentials.append(credential)
                }
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

    /// Starts a sign-in on the integration's own page; `SignInForm` takes the address where it ends.
    private func connect(_ integration: Integration) {
        Task {
            await session.run {
                let page = try await session.api.connectIntegration(
                    workspaceID: workspaceID, integrationID: integration.id
                )
                signingIn = SignIn(integration: integration, page: page.url)
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
            GolemTextField(integration.secretLabel ?? "Secret", text: $secret, secure: true)
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

/// A sign-in that someone started on an integration's own page.
private struct SignIn: Identifiable {
    let integration: Integration
    let page: URL
    var id: String { integration.id }
}

/// Signs in to an integration on its own page, which ends at a localhost address that the person pastes here.
private struct SignInForm: View {
    let workspaceID: String
    let signIn: SignIn
    let added: (Credential) -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var busy = false

    var body: some View {
        Dialog(title: "Connect \(signIn.integration.name)") {
            Link("Sign in to \(signIn.integration.name)", destination: signIn.page)
                .buttonStyle(.golem(.secondary, .large))
            GolemTextField("Address after sign-in", text: $address)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button("Connect", action: save)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy || address.isEmpty)
        }
    }

    private func save() {
        busy = true
        Task {
            await session.run {
                added(try await session.api.finishSignIn(
                    workspaceID: workspaceID, integrationID: signIn.integration.id, address: address
                ))
                session.show("\(signIn.integration.name) connected", .success)
                dismiss()
            }
            busy = false
        }
    }
}
