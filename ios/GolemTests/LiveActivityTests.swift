import Foundation
import Testing

@testable import Golem

/// The Live Activity reads Golem's pushes and opens its thread.
@Suite("Live Activity")
struct LiveActivityTests {
    @Test func theContentStateDecodesGolemsActivityState() throws {
        let json = Data(#"{"status":"waiting","title":"Plan the trip","threads":2}"#.utf8)
        let state = try JSONDecoder().decode(ThreadActivityAttributes.ContentState.self, from: json)
        #expect(state == .init(status: .waiting, title: "Plan the trip", threads: 2))
    }

    @Test func itsLinkOpensItsThread() {
        let attributes = ThreadActivityAttributes(workspaceId: "home", threadId: "trip", startedAt: .now)
        #expect(Push.tapped(attributes.url) == Push.Tapped(workspaceID: "home", destination: .thread("trip")))
        #expect(Push.tapped(URL(string: "https://example.com/thread/trip")!) == nil)
    }
}
