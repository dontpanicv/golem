import Foundation

/// The integrations, with the person's own credentials in the workspace and the ones other members shared.
extension APIClient {
    func integrations(workspaceID: String) async throws -> [Integration] {
        try await get("/api/v1/workspaces/\(workspaceID)/integrations")
    }

    /// The page where the person signs in to an integration; it ends at a localhost address that they paste.
    /// `server` is the address of the person's own server, for an integration with `address`.
    func connectIntegration(
        workspaceID: String, integrationID: String, server: String? = nil
    ) async throws -> ConnectPage {
        let body: [String: Any] = server.map { ["address": $0] } ?? [:]
        return try await post("/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)/connect", body)
    }

    func finishSignIn(workspaceID: String, integrationID: String, address: String) async throws -> Credential {
        try await post(
            "/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)/sign-in", ["address": address]
        )
    }

    /// The code that the person enters on the phone of `phone`; `finishLink` waits until they did.
    func linkIntegration(workspaceID: String, integrationID: String, phone: String) async throws -> LinkCode {
        try await post(
            "/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)/connect", ["phone": phone]
        )
    }

    func finishLink(workspaceID: String, integrationID: String) async throws -> Credential {
        try await post("/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)/sign-in", [:])
    }

    /// `fields` has the `secret`, and the `label`, `address`, and `username` that the integration needs.
    func addCredential(
        workspaceID: String, integrationID: String, fields: [String: String]
    ) async throws -> Credential {
        try await post("/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)/credentials", fields)
    }

    /// Sets the OAuth client that Golem signs in to an integration with; only the server's owner may.
    func setIntegrationClient(integrationID: String, clientID: String, clientSecret: String) async throws {
        _ = try await send(
            "PUT", "/api/v1/integrations/\(integrationID)/client",
            ["clientId": clientID, "clientSecret": clientSecret]
        )
    }

    /// Shares the person's credential with every member's turns, or makes it private to their own again.
    func setCredentialShared(workspaceID: String, credentialID: String, shared: Bool) async throws -> Credential {
        try decode(
            try await send("PUT", "/api/v1/workspaces/\(workspaceID)/credentials/\(credentialID)", ["shared": shared])
                .data
        )
    }

    /// Lets Golem find the person's tasks in their own credential, or stops it.
    func setCredentialWatched(workspaceID: String, credentialID: String, watched: Bool) async throws -> Credential {
        try decode(
            try await send("PUT", "/api/v1/workspaces/\(workspaceID)/credentials/\(credentialID)", ["watched": watched])
                .data
        )
    }

    func deleteCredential(workspaceID: String, credentialID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/credentials/\(credentialID)")
    }
}

struct Credential: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    /// The person who connected it; only they share or delete it.
    let ownerId: String
    let ownerName: String
    /// Whether every member's turns use it; else only its owner's.
    var shared: Bool
    /// Whether its owner lets Golem find their tasks in it.
    var watched: Bool
    let createdAt: Double
}

struct Integration: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    /// How people connect it: with a secret, by signing in on its page, or by linking a phone number with a code.
    let connect: Connection
    /// The name of the secret, for `.secret`.
    let secretLabel: String?
    /// Whether the person names a credential; else Golem names it from the secret.
    let labeled: Bool
    /// Whether the secret, or the sign-in, also needs the address of the person's own server.
    let address: Bool
    /// The name of the account that the secret also needs, such as "Email", which names the credential.
    let username: String?
    /// The steps that set it up, in Markdown; empty when Connect is all.
    let guide: [String]
    /// Whether Golem can find its owner's tasks in a credential of it.
    let watchable: Bool
    /// Golem's own OAuth client, which the server's owner sets; nil for integrations without one.
    let client: Client?
    var credentials: [Credential]

    enum Connection: String, Codable { case secret, signIn = "sign-in", phone }

    struct Client: Codable, Hashable {
        let clientId: String?
        /// Whether this person may set it.
        let changeable: Bool
    }
}
