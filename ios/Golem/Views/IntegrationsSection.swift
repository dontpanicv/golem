import SwiftUI

/// The integrations and credentials of a workspace, for every member's turns there, or the person's own for a nil
/// `workspaceID`, for their turns in each of their workspaces. Secrets go to the server and never come back.
struct IntegrationsSection: View {
    let workspaceID: String?
    @Environment(Session.self) private var session
    @State private var integrations: [Integration] = []
    @State private var addingTo: Integration?
    @State private var signingIn: SignIn?
    @State private var linking: Integration?

    var body: some View {
        Group {
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
                        switch integration.connect {
                        case .signIn:
                            Button("Connect", systemImage: "link") { connect(integration) }
                                .buttonStyle(.golem(.ghost, .small))
                        case .phone:
                            Button("Link number", systemImage: "link") { linking = integration }
                                .buttonStyle(.golem(.ghost, .small))
                        case .secret:
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
        .task { await load() }
        .sheet(item: $signingIn) { signIn in
            SignInForm(workspaceID: workspaceID, signIn: signIn) { credential in
                if let index = integrations.firstIndex(where: { $0.id == signIn.integration.id }) {
                    integrations[index].credentials.append(credential)
                }
            }
        }
        .sheet(item: $linking) { integration in
            LinkForm(workspaceID: workspaceID, integration: integration) { credential in
                if let index = integrations.firstIndex(where: { $0.id == integration.id }) {
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
            integrations = try await session.api.integrations(workspaceID: workspaceID)
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

private struct CredentialForm: View {
    let workspaceID: String?
    let integration: Integration
    let added: (Credential) -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var secret = ""
    @State private var address = ""
    @State private var busy = false

    var body: some View {
        Dialog(title: "Add \(integration.name) credential") {
            GolemTextField("Label", text: $label, autofocus: true)
            if integration.address {
                GolemTextField("Address", text: $address)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            GolemTextField(integration.secretLabel ?? "Secret", text: $secret, secure: true)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button("Add", action: save)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy || label.isEmpty || secret.isEmpty || (integration.address && address.isEmpty))
        }
    }

    private func save() {
        busy = true
        Task {
            await session.run {
                added(try await session.api.addCredential(
                    workspaceID: workspaceID, integrationID: integration.id,
                    label: label, secret: secret, address: integration.address ? address : nil
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
    let workspaceID: String?
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

/// Links a phone number with a code that the person enters on their phone, in Linked devices.
private struct LinkForm: View {
    let workspaceID: String?
    let integration: Integration
    let added: (Credential) -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var phone = ""
    @State private var code: String?
    @State private var busy = false

    var body: some View {
        Dialog(title: "Link \(integration.name)") {
            if let code {
                GolemTextField("Enter in Linked devices › Link with phone number", text: .constant(code))
            } else {
                GolemTextField("Phone number", placeholder: "+420 123 456 789", text: $phone, autofocus: true)
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)
            }
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button(code == nil ? "Get code" : "Done", action: next)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy || phone.isEmpty)
        }
    }

    private func next() {
        busy = true
        Task {
            await session.run {
                if code == nil {
                    code = try await session.api.linkIntegration(
                        workspaceID: workspaceID, integrationID: integration.id, phone: phone
                    ).code
                } else {
                    added(try await session.api.finishLink(workspaceID: workspaceID, integrationID: integration.id))
                    session.show("\(integration.name) connected", .success)
                    dismiss()
                }
            }
            busy = false
        }
    }
}
