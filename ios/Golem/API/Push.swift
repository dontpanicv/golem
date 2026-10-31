import ActivityKit
import SwiftUI
import UserNotifications

/// Pushes: this device's token for Golem, the push or Live Activity the person tapped until a screen opens it, and the
/// Live Activities that Golem updates by push.
@Observable
final class Push {
    static let shared = Push()

    /// This device's APNs token in hex, once iOS gives it.
    var token: String?
    /// The push the person tapped last, until a screen opens it.
    var tapped: Tapped?

    struct Tapped: Equatable {
        let workspaceID: String
        let destination: Destination
    }

    /// The APNs environment of this build: a development-signed app gets its pushes from the sandbox.
    static let environment: String = {
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? String(contentsOf: $0, encoding: .isoLatin1) } ?? ""
        let development = profile.range(
            of: #"<key>aps-environment</key>\s*<string>development</string>"#, options: .regularExpression
        )
        return development == nil ? "production" : "sandbox"
    }()

    /// Asks once to show notifications, then gets this device's token from APNs.
    static func register() async {
        let center = UNUserNotificationCenter.current()
        let granted = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
        if granted == true { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// The thread of a Live Activity's link (`ThreadActivityAttributes.url`), as a tapped push gives it.
    static func tapped(_ url: URL) -> Tapped? {
        let path = url.pathComponents
        guard url.scheme == "golem", let workspaceID = url.host(), path.count == 3, path[1] == "thread" else {
            return nil
        }
        return Tapped(workspaceID: workspaceID, destination: .thread(path[2]))
    }

    /// Starts a Live Activity that follows the work for the person's new message in a thread, in place of one that
    /// follows an older message there, and gives Golem each of its push tokens. Golem updates and ends it.
    static func followWork(workspaceID: String, threadID: String, title: String, api: APIClient) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        Task {
            for older in Activity<ThreadActivityAttributes>.activities where older.attributes.threadId == threadID {
                await older.end(nil, dismissalPolicy: .immediate)
            }
            let attributes = ThreadActivityAttributes(workspaceId: workspaceID, threadId: threadID, startedAt: .now)
            let state = ThreadActivityAttributes.ContentState(status: .working, title: title, threads: 1)
            guard let activity = try? Activity.request(
                attributes: attributes, content: .init(state: state, staleDate: nil), pushType: .token
            ) else { return }
            for await token in activity.pushTokenUpdates {
                let hex = token.map { String(format: "%02x", $0) }.joined()
                try? await api.followActivity(threadID: threadID, token: hex, environment: environment)
            }
        }
    }
}

/// Gets the device token, and shows and opens pushes.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        Push.shared.token = token.map { String(format: "%02x", $0) }.joined()
    }

    /// Golem sends no push for a thread on screen, so one that comes while the app is open is for another screen.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// Not the async form: it calls UIKit's completion handler off the main thread, and UIKit then stops the app.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        let info = response.notification.request.content.userInfo
        guard let workspaceID = info["workspaceId"] as? String, let channelID = info["channelId"] as? String else {
            return
        }
        let destination = (info["threadId"] as? String).map { Destination.thread($0) } ?? .channel(channelID)
        Push.shared.tapped = .init(workspaceID: workspaceID, destination: destination)
    }
}
