import Foundation

/// The artifacts of the workspace and its topics, and the calls of their `golem` runtime.
extension APIClient {
    /// The artifacts of a topic, or the workspace's own for a nil `topicID`.
    func artifacts(workspaceID: String, topicID: String?) async throws -> [Artifact] {
        let place = topicID.map { "/topics/\($0)" } ?? ""
        return (try await get("/api/v1/workspaces/\(workspaceID)\(place)/artifacts") as ArtifactList).artifacts
    }

    func artifact(_ id: String) async throws -> ArtifactDetail { try await get("/api/v1/artifacts/\(id)") }

    func setArtifact(_ id: String, visibility: Artifact.Visibility) async throws -> Artifact {
        try decode(try await send("PUT", "/api/v1/artifacts/\(id)", ["visibility": visibility.rawValue]).data)
    }

    func deleteArtifact(_ id: String) async throws {
        _ = try await send("DELETE", "/api/v1/artifacts/\(id)")
    }

    func clearArtifactData(_ id: String) async throws {
        _ = try await send("DELETE", "/api/v1/artifacts/\(id)/data")
    }

    func deleteArtifactRecord(artifactID: String, recordID: String) async throws {
        _ = try await send("DELETE", "/api/v1/artifacts/\(artifactID)/records/\(recordID)")
    }

    /// A call of an artifact's `golem` runtime; `args` and the result are JSON values from `JSONSerialization`.
    func artifactCall(_ id: String, operation: String, args: Any) async throws -> Any {
        let data = try await send("POST", "/api/v1/artifacts/\(id)/rpc", ["op": operation, "args": args]).data
        let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return body?["result"] ?? NSNull()
    }
}
