import Foundation

extension APIClient {
    func following(workspaceID: String) async throws -> [FollowingCheck] {
        let response: FollowingList = try await get("/api/v1/workspaces/\(workspaceID)/following")
        return response.checks
    }

    func followingDetail(workspaceID: String, checkID: String) async throws -> FollowingDetail {
        try await get("/api/v1/workspaces/\(workspaceID)/following/\(checkID)")
    }

    func followingOverview(workspaceID: String, query: String) async throws -> FollowingOverview {
        let search = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try await get("/api/v1/workspaces/\(workspaceID)/following/overview?q=\(search)")
    }

    func changeUpdate(workspaceID: String, updateID: String, action: String) async throws -> IntakeUpdate {
        try await post("/api/v1/workspaces/\(workspaceID)/following/updates/\(updateID)", ["action": action])
    }

    /// Deletes a waiting update and blocks its senders, or its group chat: Golem deletes what it read from them, with
    /// its files, and reads nothing more from them.
    func deleteUpdate(workspaceID: String, updateID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/following/updates/\(updateID)")
    }

    /// Lets Golem read a blocked sender or chat again.
    func unblock(workspaceID: String, blockID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/following/blocks/\(blockID)")
    }

    func sendFeedback(workspaceID: String, target: String, quote: String) async throws -> IntakeFeedback {
        try await post("/api/v1/workspaces/\(workspaceID)/following/feedback", ["target": target, "quote": quote])
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
    let chatId: String?
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

struct FollowingEvidence: Codable, Hashable, Identifiable {
    let id: String
    let source: String
    let text: String
    let timestamp: Double
    let url: String?
    let fromOwner: Bool
    let attachments: [FollowingAttachment]?

    enum CodingKeys: String, CodingKey {
        case id, source, text, url, fromOwner, attachments
        case timestamp = "at"
    }

    /// "Mail (a@b.c); Balcony; Alice" reads as "Alice · Balcony".
    var name: String {
        let parts = source.components(separatedBy: "; ")
        let name = [parts.count > 2 ? parts[2] : "", parts.count > 1 ? parts[1] : ""].filter { !$0.isEmpty }
        return name.isEmpty ? source : name.joined(separator: " · ")
    }
}

/// All that intake holds for the person: its sources, its chat updates, what it keeps, and the person's feedback.
struct FollowingOverview: Codable {
    let sources: [IntakeSource]
    let updates: [IntakeUpdate]
    let kept: [IntakeKept]
    let feedback: [IntakeFeedback]
    let blocked: [IntakeBlock]
}

/// A sender, or a group chat, whose messages Golem never reads again.
struct IntakeBlock: Codable, Hashable, Identifiable {
    let id: String
    let kind: String
    let label: String
    let createdAt: Double
}

struct IntakeSource: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let readAt: Double?
    let error: String?
    let kept: Int

    var state: String {
        let read = readAt.map { "Read until \(Date(milliseconds: $0).formatted(date: .abbreviated, time: .shortened))" }
        return "\(read ?? "Not read yet") · \(kept) kept"
    }
}

struct IntakeUpdate: Codable, Hashable, Identifiable {
    let id: String
    let chatId: String?
    let chatTitle: String?
    let newChat: String?
    let body: String
    let attention: String
    let notice: String?
    let createdAt: Double
    let deliveredAt: Double?
    let cancelledAt: Double?
    let evidence: [FollowingEvidence]

    var waits: Bool { deliveredAt == nil && cancelledAt == nil }
    var title: String { chatTitle ?? "New chat: \(newChat ?? "untitled")" }

    /// The message, without the source links after it.
    var message: String {
        guard let end = body.range(of: "\n\n", options: .backwards) else { return body }
        return String(body[..<end.lowerBound])
    }

    var state: String {
        if let deliveredAt { return "Posted \(Date(milliseconds: deliveredAt).formatted())" }
        if let cancelledAt { return "Not sent · \(Date(milliseconds: cancelledAt).formatted())" }
        return attention == "brief" ? "Waits for the 08:00 review" : "Posts within a minute"
    }
}

struct IntakeKept: Codable, Hashable, Identifiable {
    let id: String
    let source: String
    let text: String
    let timestamp: Double
    let url: String?
    let fromOwner: Bool
    let attachments: [FollowingAttachment]?
    let outcome: String
    let chatId: String?
    let place: String?

    enum CodingKeys: String, CodingKey {
        case id, source, text, url, fromOwner, attachments, outcome, chatId, place
        case timestamp = "at"
    }

    var evidence: FollowingEvidence {
        FollowingEvidence(
            id: id, source: source, text: text, timestamp: timestamp, url: url, fromOwner: fromOwner,
            attachments: attachments
        )
    }

    var badge: String {
        switch outcome {
        case "chat": "In chat"
        case "filed": "Filed"
        default: "Context"
        }
    }

    /// Where the observation went: its chat, its topic's files, or only Golem's context.
    var location: String {
        switch outcome {
        case "chat": "In \(place ?? "a chat")"
        case "filed": "Filed in \(place ?? "a topic")"
        default: "Kept as context"
        }
    }
}

struct IntakeFeedback: Codable, Hashable, Identifiable {
    let id: String
    let target: String
    let about: String
    let quote: String
    let createdAt: Double
}

struct FollowingAttachment: Codable, Hashable { let name: String }

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
