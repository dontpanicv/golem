import SwiftUI
import Testing
import UIKit

@testable import Golem

/// The form of a place keeps the app responsive: map content that followed the camera once froze the app.
@Suite("Place form")
@MainActor
struct PlaceFormTests {
    @Test(arguments: [false, true]) func opensWithoutFreezingTheApp(existing: Bool) async throws {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = try #require(scenes.first?.windows.first)
        let root = UIViewController()
        window.rootViewController = root
        let place = existing ? Place(
            id: "office", name: "Office", latitude: 50.0875, longitude: 14.4213, radius: 300, ownerId: "me",
            ownerName: "Me", shared: false
        ) : nil
        root.present(
            UIHostingController(rootView: PlaceForm(workspaceID: "home", place: place) { _ in }.environment(Session())),
            animated: false
        )
        // Each sleep resumes on the main chat, so a frozen app gets far fewer than the 30 ticks of 3 seconds.
        let started = Date()
        var ticks = 0
        while Date().timeIntervalSince(started) < 3 {
            try await Task.sleep(for: .milliseconds(100))
            ticks += 1
        }
        #expect(ticks > 20)
        root.dismiss(animated: false)
    }
}
