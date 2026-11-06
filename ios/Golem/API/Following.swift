import Foundation

extension APIClient {
    func following(workspaceID: String) async throws -> [FollowingCheck] {
        let response: FollowingList = try await get("/api/v1/workspaces/\(workspaceID)/following")
        return response.checks
    }

    func followingDetail(workspaceID: String, checkID: String) async throws -> FollowingDetail {
        try await get("/api/v1/workspaces/\(workspaceID)/following/\(checkID)")
    }

    func changeFollowing(
        workspaceID: String, check: FollowingCheck, action: String, quote: String
    ) async throws -> FollowingDetail {
        try await post(
            "/api/v1/workspaces/\(workspaceID)/following/\(check.id)",
            ["action": action, "revision": check.revision, "quote": quote]
        )
    }
}

private struct FollowingList: Codable { let checks: [FollowingCheck] }

struct FollowingCheck: Codable, Hashable, Identifiable {
    let id: String
    let revision: Int
    let text: String
    let state: String
    let threadId: String?
    let checkAt: Double
    let reviewAt: Double
    let explicitTime: Int
    let updatedAt: Double

    var stateLabel: String {
        switch state {
        case "resolved": "Handled"
        case "stopped": "Stopped"
        default: "Following"
        }
    }
}

struct FollowingDetail: Codable {
    let check: FollowingCheck
    let evidence: [FollowingEvidence]
    let history: [FollowingRevision]
}

struct FollowingEvidence: Codable, Identifiable {
    let id: String
    let source: String
    let text: String
    let timestamp: Double
    let url: String?
    let attachments: [FollowingAttachment]?

    enum CodingKeys: String, CodingKey {
        case id, source, text, url, attachments
        case timestamp = "at"
    }
}

struct FollowingAttachment: Codable { let name: String }

struct FollowingRevision: Codable, Identifiable {
    let id: Int
    let timestamp: Double
    let action: String
    let quote: String?
    let previous: FollowingSnapshot?
    let current: FollowingSnapshot

    enum CodingKeys: String, CodingKey {
        case id, action, quote, previous, current
        case timestamp = "at"
    }
}

struct FollowingSnapshot: Codable {
    let text: String
    let state: String
    let checkAt: Double
    let explicitTime: Int
}
