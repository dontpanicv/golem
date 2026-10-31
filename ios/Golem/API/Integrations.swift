import Foundation

/// The integrations, with the person's own credentials in the workspace and the ones other members shared.
extension APIClient {
    func integrations(workspaceID: String) async throws -> [Integration] {
        try await get("/api/v1/workspaces/\(workspaceID)/integrations")
    }

    /// The page where the person signs in to an integration; it ends at a localhost address that they paste.
    func connectIntegration(workspaceID: String, integrationID: String) async throws -> ConnectPage {
        try await post("/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)/connect", [:])
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

    func addCredential(
        workspaceID: String, integrationID: String, label: String?, secret: String, address: String?
    ) async throws -> Credential {
        var body = ["secret": secret]
        body["label"] = label
        body["address"] = address
        return try await post(
            "/api/v1/workspaces/\(workspaceID)/integrations/\(integrationID)/credentials",
            body
        )
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

    func deleteCredential(workspaceID: String, credentialID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/credentials/\(credentialID)")
    }
}
