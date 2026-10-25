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
        Form {
            Section("Members") {
                ForEach(members) { member in
                    HStack(spacing: Tokens.Space.lg) {
                        Avatar(name: member.name)
                        VStack(alignment: .leading, spacing: Tokens.Space.xxs) {
                            Text(member.name).foregroundStyle(Tokens.Colors.text)
                            Text(member.email)
                                .font(.golem(Tokens.FontSize.sm))
                                .foregroundStyle(Tokens.Colors.textTertiary)
                        }
                        Spacer()
                        Badge(label: member.role.capitalized)
                    }
                }
                HStack {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Add", action: addMember)
                        .buttonStyle(.secondary)
                        .disabled(email.isEmpty)
                }
            }
            ForEach($integrations) { $integration in
                Section(integration.name) {
                    Toggle("Enabled", isOn: Binding(get: { integration.enabled }, set: { setEnabled($integration, $0) }))
                    ForEach(integration.credentials) { credential in
                        HStack {
                            VStack(alignment: .leading, spacing: Tokens.Space.xxs) {
                                Text(credential.label).foregroundStyle(Tokens.Colors.text)
                                Text(credential.ownerName)
                                    .font(.golem(Tokens.FontSize.sm))
                                    .foregroundStyle(Tokens.Colors.textTertiary)
                            }
                            Spacer()
                            Badge(label: credential.shared ? "Shared with workspace" : "Only me", tone: credential.shared ? .accent : .neutral)
                        }
                        .deleteDisabled(!credential.mine)
                    }
                    .onDelete { offsets in deleteCredentials($integration, at: offsets) }
                    Button("Add credential", systemImage: "plus") { addingTo = integration }
                }
            }
        }
        .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
        .scrollContentBackground(.hidden)
        .background(Tokens.Colors.canvas)
        .navigationTitle(session.workspace?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
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
        Task {
            await session.run {
                members.append(try await session.api.addMember(workspaceID: workspaceID, email: email))
                self.email = ""
            }
        }
    }

    private func setEnabled(_ integration: Binding<Integration>, _ enabled: Bool) {
        integration.wrappedValue.enabled = enabled
        let integrationID = integration.wrappedValue.id
        Task {
            await session.run {
                do {
                    integration.wrappedValue = try await session.api.setIntegration(workspaceID: workspaceID, integrationID: integrationID, enabled: enabled)
                } catch {
                    integration.wrappedValue.enabled = !enabled
                    throw error
                }
            }
        }
    }

    private func deleteCredentials(_ integration: Binding<Integration>, at offsets: IndexSet) {
        for credential in offsets.map({ integration.wrappedValue.credentials[$0] }) {
            Task {
                await session.run {
                    try await session.api.deleteCredential(workspaceID: workspaceID, credentialID: credential.id)
                    integration.wrappedValue.credentials.removeAll { $0.id == credential.id }
                }
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
    @State private var failure: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Label", text: $label)
                    SecureField(integration.secretLabel, text: $secret)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Toggle("Share with all agents in this workspace", isOn: $shared)
                }
                if let failure {
                    Text(failure).foregroundStyle(Tokens.Colors.danger)
                }
            }
            .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.book))
            .scrollContentBackground(.hidden)
            .background(Tokens.Colors.canvas)
            .navigationTitle(integration.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add", action: save).disabled(busy || label.isEmpty || secret.isEmpty)
                }
            }
        }
        .tint(Tokens.Colors.accent)
    }

    private func save() {
        busy = true
        Task {
            do {
                added(try await session.api.addCredential(
                    workspaceID: workspaceID, integrationID: integration.id, label: label, secret: secret, shared: shared
                ))
                dismiss()
            } catch {
                failure = error.localizedDescription
            }
            busy = false
        }
    }
}
