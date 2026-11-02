import SwiftUI

/// A sign-in that someone started on an integration's own page; `page` is nil until the person gives the address of
/// their own server, for an integration with `address`.
struct IntegrationSignIn: Identifiable {
    let integration: Integration
    let page: URL?
    var id: String { integration.id }
}

/// Signs in to an integration on its own page, which ends at a localhost address that the person pastes here.
struct SignInForm: View {
    let workspaceID: String
    let signIn: IntegrationSignIn
    let added: (Credential) -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var page: URL?
    @State private var server = ""
    @State private var address = ""
    @State private var busy = false

    var body: some View {
        Dialog(title: "Connect \(signIn.integration.name)") {
            if let page = page ?? signIn.page {
                Link("Sign in to \(signIn.integration.name)", destination: page)
                    .buttonStyle(.golem(.secondary, .large))
                GolemTextField("Address after sign-in", text: $address)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
            } else {
                GolemTextField("Address", placeholder: "http://my-mac:3774", text: $server, autofocus: true)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
            }
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            if page ?? signIn.page == nil {
                Button("Continue", action: start)
                    .buttonStyle(.golem(.primary, .large))
                    .disabled(busy || server.isEmpty)
            } else {
                Button("Connect", action: save)
                    .buttonStyle(.golem(.primary, .large))
                    .disabled(busy || address.isEmpty)
            }
        }
    }

    /// Starts the sign-in at the person's own server.
    private func start() {
        busy = true
        Task {
            await session.run {
                page = try await session.api.connectIntegration(
                    workspaceID: workspaceID, integrationID: signIn.integration.id, server: server
                ).url
            }
            busy = false
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
