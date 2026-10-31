import Foundation

/// What Golem learned from quiet threads that the person sees, and how much the model was used.
extension APIClient {
    /// Facts first.
    func learned(workspaceID: String) async throws -> [Learned] {
        (try await get("/api/v1/workspaces/\(workspaceID)/learned") as LearnedList).learned
    }

    func setLearned(workspaceID: String, id: Int, text: String) async throws -> Learned {
        try decode(try await send("PUT", "/api/v1/workspaces/\(workspaceID)/learned/\(id)", ["text": text]).data)
    }

    /// Golem does not learn it again.
    func deleteLearned(workspaceID: String, id: Int) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/learned/\(id)")
    }

    /// The person's own use of the last `days` days; the server's owner gets everyone's.
    func usage(workspaceID: String, days: Int) async throws -> Usage {
        try await get("/api/v1/workspaces/\(workspaceID)/usage?days=\(days)")
    }
}

/// A fact about a person (`about`), or how to do a task in a channel, or in the person's orchestrator when
/// `channelId` is nil (`howto`). `realm` is the person who alone sees it; nil for every member.
struct Learned: Codable, Hashable, Identifiable {
    enum Kind: String, Codable { case about, howto }

    let id: Int
    let kind: Kind
    let personId: String?
    let channelId: String?
    let realm: String?
    var text: String
    let threadId: String?
    let updatedAt: Double
}

struct LearnedList: Codable { let learned: [Learned] }

struct Usage: Codable, Hashable {
    /// Oldest first; a day without use is left out.
    let days: [UsageTotals]
    let total: UsageTotals
    /// Most cost first.
    let sources: [UsageTotals]
    let models: [UsageTotals]
    /// The 10 that cost most, of those the person sees.
    let threads: [UsageTotals]
    /// Only for the server's owner.
    let people: [UsageTotals]?
}

/// Tokens and the cost in US dollars at the model's list price. `input` leaves out `cacheRead`. A row of a list has
/// its own key too: `day` ("YYYY-MM-DD" in UTC), `source`, `model`, `threadId` and `title`, or `userId` and `name`.
struct UsageTotals: Codable, Hashable {
    let input: Double
    let output: Double
    let cacheRead: Double
    let cacheWrite: Double
    let cost: Double
    var day: String?
    var source: String?
    var model: String?
    var threadId: String?
    var title: String?
    var userId: String?
    var name: String?

    var tokens: Double { input + output + cacheRead + cacheWrite }
    /// The part of the prompt that came from the cache.
    var cacheRate: Double { input + cacheRead == 0 ? 0 : cacheRead / (input + cacheRead) }
}
