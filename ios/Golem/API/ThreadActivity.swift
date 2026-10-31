import ActivityKit
import Foundation

/// The Live Activity of the work for the person's message in a thread. The app starts it; Golem pushes each change of
/// `ContentState` (docs/api.md `ActivityState`) and its end. Compiled into the app and the GolemActivity extension.
nonisolated struct ThreadActivityAttributes: ActivityAttributes {
    /// Decodes the push's `content-state` as Golem sends it.
    struct ContentState: Codable, Hashable {
        let status: ThreadActivityStatus
        /// The thread that works now, or the message's thread at the end.
        let title: String
        /// How many threads work on it now.
        let threads: Int
    }

    let workspaceId: String
    let threadId: String
    let startedAt: Date

    /// Opens the thread in the app (`Push.tapped(_:)`).
    var url: URL { URL(string: "golem://\(workspaceId)/thread/\(threadId)")! }
}

/// Waiting: for the person to allow an action.
nonisolated enum ThreadActivityStatus: String, Codable {
    case working, waiting, done, failed
}
