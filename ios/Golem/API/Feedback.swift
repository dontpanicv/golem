import Foundation

/// What agents report about Golem itself; only the server's owner reads and dismisses it.
extension APIClient {
    func feedback(workspaceID: String) async throws -> [Feedback] {
        let response: FeedbackList = try await get("/api/v1/workspaces/\(workspaceID)/feedback")
        return response.feedback
    }

    func dismissFeedback(workspaceID: String, feedbackID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/feedback/\(feedbackID)")
    }
}

private struct FeedbackList: Codable {
    let feedback: [Feedback]
}

struct Feedback: Codable, Hashable, Identifiable {
    enum Kind: String, Codable {
        case error, missing, better
    }

    let id: String
    let kind: Kind
    let tool: String?
    let summary: String
    let detail: String
    /// Nil when the owner does not see the chat, such as another person's private topic.
    let chatId: String?
    let createdAt: Double
}
