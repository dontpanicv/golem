import MessageUI
import UIKit

/// Messages, mail, and calls: iOS fills them in, and the person sends or dials (MessageUI, and the tel and facetime
/// links).
enum Compose {
    private struct MessageArguments: Decodable {
        let recipients: [String]
        let body: String
    }

    private struct MailArguments: Decodable {
        let to: [String]
        let cc: [String]?
        let subject: String
        let body: String
    }

    private struct CallArguments: Decodable {
        let to: String
        let kind: String?
    }

    static func message(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(MessageArguments.self)
        guard MFMessageComposeViewController.canSendText() else { throw PhoneError("This phone cannot send messages.") }
        let controller = MFMessageComposeViewController()
        controller.recipients = arguments.recipients
        controller.body = arguments.body
        let top = try PhoneLink.topScreen()
        let delegate = MessageDelegate()
        controller.messageComposeDelegate = delegate
        let result = await withCheckedContinuation { continuation in
            delegate.finished = { continuation.resume(returning: $0) }
            top.present(controller, animated: true)
        }
        let text = switch result {
        case .sent: "The person sent the message."
        case .cancelled: "The person did not send the message."
        default: "The message failed."
        }
        return PhoneAnswer(text: text)
    }

    static func mail(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(MailArguments.self)
        guard MFMailComposeViewController.canSendMail() else {
            throw PhoneError("This phone has no Mail account that can send.")
        }
        let controller = MFMailComposeViewController()
        controller.setToRecipients(arguments.to)
        controller.setCcRecipients(arguments.cc)
        controller.setSubject(arguments.subject)
        controller.setMessageBody(arguments.body, isHTML: false)
        let top = try PhoneLink.topScreen()
        let delegate = MailDelegate()
        controller.mailComposeDelegate = delegate
        let result = await withCheckedContinuation { continuation in
            delegate.finished = { continuation.resume(returning: $0) }
            top.present(controller, animated: true)
        }
        let text = switch result {
        case .sent: "The person sent the email."
        case .saved: "The person saved the email as a draft."
        case .cancelled: "The person did not send the email."
        default: "The email failed."
        }
        return PhoneAnswer(text: text)
    }

    static func call(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(CallArguments.self)
        let scheme = switch arguments.kind ?? "phone" {
        case "facetime": "facetime"
        case "facetime_audio": "facetime-audio"
        default: "tel"
        }
        let address = arguments.to.filter { !$0.isWhitespace }
        guard let url = URL(string: "\(scheme):\(address)") else { throw PhoneError("\(arguments.to) is not callable.") }
        return PhoneAnswer(text: "iOS asks the person to call \(arguments.to).") {
            await UIApplication.shared.open(url)
        }
    }

    private final class MessageDelegate: NSObject, MFMessageComposeViewControllerDelegate {
        var finished: (MessageComposeResult) -> Void = { _ in }

        func messageComposeViewController(
            _ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult
        ) {
            controller.dismiss(animated: true)
            finished(result)
        }
    }

    private final class MailDelegate: NSObject, MFMailComposeViewControllerDelegate {
        var finished: (MFMailComposeResult) -> Void = { _ in }

        func mailComposeController(
            _ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?
        ) {
            controller.dismiss(animated: true)
            finished(result)
        }
    }
}
