import Intents
import UserNotifications

/// Shows a push from a thread as a message from Golem in a conversation named after the thread, so Siri reads it aloud
/// on AirPods and in CarPlay, and sends a spoken reply to the thread (`SiriReply`). Other pushes stay as they are.
nonisolated final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        let content = request.content
        guard content.categoryIdentifier == "message", let threadID = content.userInfo["threadId"] as? String else {
            return contentHandler(content)
        }
        let golem = INPerson(
            personHandle: INPersonHandle(value: "golem", type: .unknown), nameComponents: nil, displayName: "Golem",
            image: nil, contactIdentifier: nil, customIdentifier: "golem"
        )
        let intent = INSendMessageIntent(
            recipients: nil, outgoingMessageType: .outgoingMessageText, content: content.body,
            speakableGroupName: INSpeakableString(spokenPhrase: content.title), conversationIdentifier: threadID,
            serviceName: nil, sender: golem, attachments: nil
        )
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { _ in
            contentHandler((try? content.updating(from: intent)) ?? content)
        }
    }
}
