import Foundation
import Testing

@testable import Golem

/// The Live Activity reads Golem's pushes and opens its chat.
@Suite("Live Activity")
struct LiveActivityTests {
    @Test func theContentStateDecodesGolemsActivityState() throws {
        let json = Data(#"{"status":"waiting","title":"Plan the trip","chats":2}"#.utf8)
        let state = try JSONDecoder().decode(ChatActivityAttributes.ContentState.self, from: json)
        #expect(state == .init(status: .waiting, title: "Plan the trip", chats: 2))
    }

    @Test func itsLinkOpensItsChat() {
        let attributes = ChatActivityAttributes(workspaceId: "home", chatId: "trip", startedAt: .now)
        #expect(Push.tapped(attributes.url) == Push.Tapped(workspaceID: "home", destination: .chat("trip")))
        #expect(Push.tapped(URL(string: "https://example.com/chat/trip")!) == nil)
    }
}
