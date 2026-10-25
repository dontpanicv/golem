import SwiftUI

/// Members and integrations of the open workspace.
struct WorkspaceSettingsView: View {
    @Environment(Session.self) private var session
    @State private var members: [Member] = []
    @State private var integrations: [Integration] = []
    @State private var email = ""
    @State private var addingTo: Integration?

    private var workspaceID: String { session.workspace?.id ?? "" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.xxxl) {
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
                ForEach($integrations) { $integration in
                    SettingsCard(title: integration.name) {
                        SettingsRow("Enabled", description: "Agents in this workspace can use \(integration.name)") {
                            let enabled = Binding(
                                get: { integration.enabled }, set: { setEnabled($integration, $0) }
                            )
                            Toggle(isOn: enabled) {}
                                .toggleStyle(.golemSwitch)
                                .accessibilityLabel("Enabled")
                        }
                        ForEach(integration.credentials) { credential in
                            SettingsRow(credential.label, description: credential.ownerName) {
                                HStack(spacing: Tokens.Space.xs) {
                                    Badge(
                                        label: credential.shared ? "Shared with workspace" : "Only me",
                                        tone: credential.shared ? .accent : .neutral
                                    )
                                    if credential.mine {
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
            .frame(maxWidth: 640)
            .padding(Tokens.Space.xl)
            .frame(maxWidth: .infinity)
        }
        .background(Tokens.Colors.surface)
        .navigationTitle(session.workspace?.name ?? "")
        .navigationBarTitleDisplayMode(.large)
        .task { await load() }
        .refreshable { await load() }
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
            async let integrations = session.api.integrations(workspaceID: workspaceID)
            (self.members, self.integrations) = try await (members, integrations)
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

    private func setEnabled(_ integration: Binding<Integration>, _ enabled: Bool) {
        integration.wrappedValue.enabled = enabled
        let integrationID = integration.wrappedValue.id
        Task {
            await session.run {
                do {
                    integration.wrappedValue = try await session.api.setIntegration(
                        workspaceID: workspaceID, integrationID: integrationID, enabled: enabled
                    )
                } catch {
                    integration.wrappedValue.enabled = !enabled
                    throw error
                }
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

private struct CredentialForm: View {
    let workspaceID: String
    let integration: Integration
    let added: (Credential) -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var secret = ""
    @State private var shared = false
    @State private var busy = false

    var body: some View {
        Dialog(title: "Add \(integration.name) credential") {
            GolemTextField("Label", text: $label, autofocus: true)
            GolemTextField(integration.secretLabel, text: $secret, secure: true)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Toggle("Share with all agents in this workspace", isOn: $shared)
                .toggleStyle(.checkbox)
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
                    label: label, secret: secret, shared: shared
                ))
                session.show("Credential added", .success)
                dismiss()
            }
            busy = false
        }
    }
}
