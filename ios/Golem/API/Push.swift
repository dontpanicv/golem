import SwiftUI
import UserNotifications

/// Pushes: this device's token for Golem, and the push the person tapped until a screen opens it.
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
