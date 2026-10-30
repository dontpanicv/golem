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
    @State private var settingClient: Integration?
    @State private var guiding: Integration?

    // One card, not a card per integration: modifiers on a `Group` attach to each child, so with no integrations
    // loaded yet the load never ran, and with several each sheet attached once per integration.
    var body: some View {
        SettingsCard(title: "Integrations") {
            ForEach($integrations) { $integration in
                if integration.id != integrations.first?.id { ListSeparator() }
                SettingsRow(integration.name, description: summary(integration)) {
                    if !integration.guide.isEmpty {
                        Button("Set up \(integration.name)", systemImage: "info.circle") { guiding = integration }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.golem(.ghost, .icon))
                    }
                }
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
                            .disabled(integration.client.map { $0.clientId == nil } ?? false)
                    case .phone:
                        Button("Link number", systemImage: "link") { linking = integration }
                            .buttonStyle(.golem(.ghost, .small))
                    case .secret:
                        Button("Add credential", systemImage: "plus") { addingTo = integration }
                            .buttonStyle(.golem(.ghost, .small))
                    }
                    if integration.client?.changeable == true {
                        Button("Client", systemImage: "key") { settingClient = integration }
                            .buttonStyle(.golem(.ghost, .small))
                    }
                    Spacer()
                }
                .padding(.horizontal, Tokens.Space.md)
                .padding(.vertical, Tokens.Space.lg)
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
        .sheet(item: $guiding) { integration in
            Guide(integration: integration)
        }
        .sheet(item: $settingClient) { integration in
            ClientForm(integration: integration) { Task { await load() } }
        }
        .sheet(item: $addingTo) { integration in
            CredentialForm(workspaceID: workspaceID, integration: integration) { credential in
                if let index = integrations.firstIndex(where: { $0.id == integration.id }) {
                    integrations[index].credentials.append(credential)
                }
            }
        }
    }

    /// The count of accounts, and what the secret is, as on the web.
    private func summary(_ integration: Integration) -> String {
        let count = integration.credentials.count
        let accounts = count == 0 ? "Not connected" : count == 1 ? "1 account" : "\(count) accounts"
        return integration.secretLabel.map { "\(accounts) · \($0)" } ?? accounts
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

/// The steps that set up an integration, numbered; links open, and the text can be copied.
private struct Guide: View {
    let integration: Integration
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Dialog(title: "Set up \(integration.name)") {
            ScrollView {
                VStack(alignment: .leading, spacing: Tokens.Space.lg) {
                    ForEach(Array(integration.guide.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.md) {
                            Text("\(index + 1).")
                                .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                                .monospacedDigit()
                            Text(LocalizedStringKey(step))
                                .foregroundStyle(Tokens.Mobile.Colors.text)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .font(.golem(Tokens.FontSize.sm, Tokens.FontWeight.book))
                    }
                }
            }
            .frame(maxHeight: 520)
        } actions: {
            Button("Done") { dismiss() }.buttonStyle(.golem(.primary, .large))
        }
    }
}

/// The OAuth client that Golem signs in to an integration with, which the server's owner sets.
private struct ClientForm: View {
    let integration: Integration
    let saved: () -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var clientID: String
    @State private var clientSecret = ""
    @State private var busy = false

    init(integration: Integration, saved: @escaping () -> Void) {
        self.integration = integration
        self.saved = saved
        _clientID = State(initialValue: integration.client?.clientId ?? "")
    }

    var body: some View {
        Dialog(title: "\(integration.name) OAuth client") {
            GolemTextField("Client ID", text: $clientID, autofocus: true)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            GolemTextField("Client secret", text: $clientSecret, secure: true)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button("Save", action: save)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy || clientID.isEmpty || clientSecret.isEmpty)
        }
    }

    private func save() {
        busy = true
        Task {
            await session.run {
                try await session.api.setIntegrationClient(
                    integrationID: integration.id, clientID: clientID, clientSecret: clientSecret
                )
                session.show("\(integration.name) client saved", .success)
                saved()
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
