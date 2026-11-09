import ActivityKit
import Intents
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

    /// Asks once to show notifications, then gets this device's token from APNs. Siri then reads Golem's messages
    /// aloud on AirPods and takes spoken replies (`SiriReply`).
    static func register() async {
        let center = UNUserNotificationCenter.current()
        let granted = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
        if granted == true { UIApplication.shared.registerForRemoteNotifications() }
        INPreferences.requestSiriAuthorization { _ in }
    }

    /// The buttons of a push (`apnsPayload`), on the iPhone and on the watch. Double Tap on the watch runs the first:
    /// Reply starts dictation, and Deny allows nothing.
    static let categories: Set<UNNotificationCategory> = [
        UNNotificationCategory(
            identifier: "message",
            actions: [
                UNTextInputNotificationAction(
                    identifier: Action.reply, title: "Reply", textInputButtonTitle: "Send",
                    textInputPlaceholder: "Message"
                ),
                UNNotificationAction(identifier: Action.snooze, title: "Snooze 15 min"),
                UNNotificationAction(identifier: Action.done, title: "Done")
            ],
            intentIdentifiers: [INSendMessageIntentIdentifier]
        ),
        UNNotificationCategory(
            identifier: "approval",
            actions: [
                UNNotificationAction(identifier: Action.deny, title: "Deny"),
                UNNotificationAction(identifier: Action.allow, title: "Allow")
            ],
            intentIdentifiers: []
        )
    ]

    enum Action {
        static let reply = "reply"
        static let snooze = "snooze"
        static let done = "done"
        static let deny = "deny"
        static let allow = "allow"
    }

    /// Does what a push's button says, in the background, then marks the push read. When Golem does not get it, a
    /// notification says so and keeps a reply's text, so nothing the person said is lost.
    static func act(on response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let info = content.userInfo
        guard let workspaceID = info["workspaceId"] as? String, let chatID = info["chatId"] as? String,
              let notificationID = info["notificationId"] as? String else { return }
        let api = APIClient.signedIn()
        let reply = (response as? UNTextInputNotificationResponse)?.userText
        do {
            switch response.actionIdentifier {
            case Action.reply:
                guard let reply, !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                try await api.sendMessage(chatID: chatID, text: reply, files: [])
            case Action.snooze:
                // The agent makes reminders, so it makes this one too, from the reminder above in the chat.
                try await api.sendMessage(
                    chatID: chatID, text: "Remind me about this again in 15 minutes.", files: []
                )
            case Action.allow, Action.deny:
                guard let approvalID = info["approvalId"] as? String else { return }
                try await api.answerApproval(
                    chatID: chatID, approvalID: approvalID, allow: response.actionIdentifier == Action.allow
                )
            default:
                break
            }
            let inbox = try await api.readNotifications(workspaceID: workspaceID, id: notificationID)
            try? await UNUserNotificationCenter.current().setBadgeCount(inbox.badge)
        } catch {
            let failed = UNMutableNotificationContent()
            failed.title = "Golem did not get it"
            failed.body = reply.map { "\($0)\n\(error.localizedDescription)" } ?? error.localizedDescription
            failed.threadIdentifier = content.threadIdentifier
            failed.userInfo = ["workspaceId": workspaceID, "topicId": info["topicId"] ?? "", "chatId": chatID]
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: UUID().uuidString, content: failed, trigger: nil)
            )
        }
    }

    /// The chat of a Live Activity's link (`ChatActivityAttributes.url`), as a tapped push gives it.
    static func tapped(_ url: URL) -> Tapped? {
        let path = url.pathComponents
        guard url.scheme == "golem", let workspaceID = url.host(), path.count == 3, path[1] == "chat" else {
            return nil
        }
        return Tapped(workspaceID: workspaceID, destination: .chat(path[2]))
    }

    /// Starts a Live Activity that follows the work for the person's new message in a chat, in place of one that
    /// follows an older message there, and gives Golem each of its push tokens. Golem updates and ends it.
    static func followWork(workspaceID: String, chatID: String, title: String, api: APIClient) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        Task {
            for older in Activity<ChatActivityAttributes>.activities where older.attributes.chatId == chatID {
                await older.end(nil, dismissalPolicy: .immediate)
            }
            let attributes = ChatActivityAttributes(workspaceId: workspaceID, chatId: chatID, startedAt: .now)
            let state = ChatActivityAttributes.ContentState(status: .working, title: title, chats: 1)
            guard let activity = try? Activity.request(
                attributes: attributes, content: .init(state: state, staleDate: nil), pushType: .token
            ) else { return }
            for await token in activity.pushTokenUpdates {
                let hex = token.map { String(format: "%02x", $0) }.joined()
                try? await api.followActivity(chatID: chatID, token: hex, environment: environment)
            }
        }
    }
}

/// Gets the device token, shows and opens pushes, and watches places from launch.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(Push.categories)
        // iOS may have started the app for an arrival at or a departure from a place.
        PlaceWatcher.shared.resume()
        return true
    }

    /// Siri's spoken reply to a message from Golem.
    func application(_ application: UIApplication, handlerFor intent: INIntent) -> Any? {
        intent is INSendMessageIntent ? SiriReply() : nil
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        Push.shared.token = token.map { String(format: "%02x", $0) }.joined()
    }

    /// Golem sends no push for a chat on screen, so one that comes while the app is open is for another screen.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// Not the async form: it calls UIKit's completion handler off the main chat, and UIKit then stops the app.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else {
            Task {
                await Push.act(on: response)
                completionHandler()
            }
            return
        }
        defer { completionHandler() }
        let info = response.notification.request.content.userInfo
        guard let workspaceID = info["workspaceId"] as? String, let topicID = info["topicId"] as? String else {
            return
        }
        let destination = (info["chatId"] as? String).map { Destination.chat($0) } ?? .topic(topicID)
        Push.shared.tapped = .init(workspaceID: workspaceID, destination: destination)
    }
}
