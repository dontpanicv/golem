import ActivityKit
import Foundation

/// The Live Activity of the work for the person's message in a chat. The app starts it; Golem pushes each change of
/// `ContentState` (docs/api.md `ActivityState`) and its end, which takes it away at once. Compiled into the app and
/// the GolemActivity extension.
nonisolated struct ChatActivityAttributes: ActivityAttributes {
    /// Decodes the push's `content-state` as Golem sends it.
    struct ContentState: Codable, Hashable {
        let status: ChatActivityStatus
        /// The chat that works now.
        let title: String
        /// How many chats work on it now.
        let chats: Int
    }

    let workspaceId: String
    let chatId: String
    let startedAt: Date

    /// Opens the chat in the app (`Push.tapped(_:)`).
    var url: URL { URL(string: "golem://\(workspaceId)/chat/\(chatId)")! }
}

/// Waiting: for the person to allow an action.
nonisolated enum ChatActivityStatus: String, Codable {
    case working, waiting
}
