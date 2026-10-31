import Foundation

/// Each person's Upcoming: what Golem runs for them, what waits for them, and the automations Golem suggests.
extension APIClient {
    func upcoming(workspaceID: String) async throws -> Upcoming {
        try await get("/api/v1/workspaces/\(workspaceID)/upcoming")
    }

    /// `accept` makes the routine or the reminder as the person's; else Golem does not suggest it again.
    func answerSuggestion(workspaceID: String, suggestionID: String, accept: Bool) async throws {
        _ = try await send(
            "POST", "/api/v1/workspaces/\(workspaceID)/suggestions/\(suggestionID)", ["accept": accept]
        )
    }

    func cancelReminder(workspaceID: String, reminderID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/reminders/\(reminderID)")
    }
}

struct Upcoming: Codable, Hashable {
    /// Every routine the person sees.
    var routines: [Routine]
    /// Pending, for the person or from them, soonest first.
    var reminders: [Reminder]
    /// Oldest first; at most 3.
    var suggestions: [Suggestion]
    /// What waits for the person to allow it.
    let approvals: [WaitingApproval]
}

struct WaitingApproval: Codable, Hashable {
    let threadId: String
    let approval: Approval
}

/// A one-time reminder that an agent made; its agent reminds in `threadId` at `dueAt`.
struct Reminder: Codable, Hashable, Identifiable {
    let id: String
    let threadId: String
    let recipientId: String
    let createdBy: String?
    let text: String
    let dueAt: Double
    let timeZone: String
    let deliveredAt: Double?
    let cancelledAt: Double?
}

/// A routine or a reminder that Golem suggests from a thread; nothing happens until the person accepts it.
struct Suggestion: Codable, Hashable, Identifiable {
    enum Kind: String, Codable { case routine, reminder }

    let id: String
    let kind: Kind
    /// The routine's name, or the reminder's text.
    let name: String
    let text: String
    /// A routine's cron expression in the server's time zone.
    let schedule: String?
    /// When the reminder is due, or the routine's first run.
    let time: Double?
    let channelId: String
    let threadId: String
    let createdAt: Double

    enum CodingKeys: String, CodingKey {
        case id, kind, name, text, schedule, channelId, threadId, createdAt
        case time = "at"
    }
}
