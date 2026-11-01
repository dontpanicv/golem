import Foundation
import UIKit

/// A call of an agent's `phone_<name>` tool (docs/api.md, Phone).
struct PhoneCall: Decodable {
    let id: String
    let workspaceId: String
    let name: String
    let rawArguments: JSONValue

    enum CodingKeys: String, CodingKey {
        case id, workspaceId, name, rawArguments = "arguments"
    }

    /// The arguments as the tool's own type; their keys are snake_case.
    func arguments<Arguments: Decodable>(_: Arguments.Type) throws -> Arguments {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(Arguments.self, from: JSONEncoder().encode(rawArguments))
    }
}

/// What a tool answers: text for the agent, and JPEG pictures that it looks at.
struct PhoneAnswer {
    var text: String
    var images: [Data] = []
    /// What the tool does after Golem has the answer, such as opening another app, which closes the stream.
    var after: (() async -> Void)?

    /// The value as JSON, which the agent reads.
    static func json(_ value: some Encodable) throws -> PhoneAnswer {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return PhoneAnswer(text: String(decoding: try encoder.encode(value), as: UTF8.self))
    }
}

/// An error that the agent reads as the tool's failure.
struct PhoneError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

/// Gives the agents the phone's tools while the app is open: it reads the calls of the person's turns from Golem, runs
/// each one with Apple's frameworks, and sends the answer back.
enum PhoneLink {
    /// Every tool, by its name without `phone_`; `src/phone/tools.ts` describes them to the agents.
    private static let tools: [String: (PhoneCall) async throws -> PhoneAnswer] = [
        "alarm_set": Alarms.set,
        "timer_start": Alarms.startTimer,
        "alarms": Alarms.list,
        "alarm_change": Alarms.change,
        "reminder_lists": Calendars.reminderLists,
        "reminders": Calendars.reminders,
        "reminder_add": Calendars.addReminder,
        "reminder_change": Calendars.changeReminder,
        "reminder_delete": Calendars.deleteReminder,
        "calendars": Calendars.calendars,
        "events": Calendars.events,
        "event_add": Calendars.addEvent,
        "event_change": Calendars.changeEvent,
        "event_delete": Calendars.deleteEvent,
        "contacts": PhoneContacts.find,
        "contact_add": PhoneContacts.add,
        "contact_change": PhoneContacts.change,
        "message": Compose.message,
        "mail": Compose.mail,
        "call": Compose.call,
        "music_play": PhoneMusic.play,
        "music_control": PhoneMusic.control,
        "photos": PhoneLibrary.find,
        "photo": PhoneLibrary.photo,
        "photo_save": PhoneLibrary.save,
        "camera": PhoneCamera.take,
        "health": PhoneHealth.read,
        "health_log": PhoneHealth.log,
        "location": PhoneLocation.current,
        "directions": PhoneLocation.directions,
        "open": PhoneDevice.open,
        "clipboard": PhoneDevice.clipboard,
        "device": PhoneDevice.status,
        "flashlight": PhoneDevice.flashlight,
        "brightness": PhoneDevice.brightness,
        "home": PhoneHome.list,
        "home_scene": PhoneHome.scene,
        "home_power": PhoneHome.power,
        "wallet_add": PhoneWallet.add,
    ]

    /// Reads the calls until cancelled, and opens the stream again after each error.
    static func follow(_ api: APIClient) async {
        while !Task.isCancelled {
            try? await api.phoneCalls { (call: PhoneCall) in
                Task { await answer(call, api) }
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private static func answer(_ call: PhoneCall, _ api: APIClient) async {
        do {
            guard let tool = tools[call.name] else { throw PhoneError("This app has no tool \(call.name); update it.") }
            let answer = try await tool(call)
            try await api.answerPhoneCall(call.id, text: answer.text, images: answer.images)
            await answer.after?()
        } catch {
            try? await api.answerPhoneCall(call.id, error: error.localizedDescription)
        }
    }

    /// The screen on top, which shows the sheets that a tool opens, such as a message to send.
    static func topScreen() throws -> UIViewController {
        let window = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first
        guard var top = window?.rootViewController else { throw PhoneError("The Golem app is not on screen.") }
        while let presented = top.presentedViewController { top = presented }
        return top
    }

    /// Downloads a file of the call's workspace, as the person can, into a temporary file that the caller removes.
    static func file(_ call: PhoneCall, _ fileId: String) async throws -> (url: URL, mimeType: String) {
        let (data, response) = try await APIClient.signedIn()
            .send("GET", "/api/v1/workspaces/\(call.workspaceId)/files/\(fileId)")
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: response.suggestedFilename ?? fileId)
        try data.write(to: url)
        return (url, response.mimeType ?? "")
    }

    /// The date of an ISO 8601 argument, with or without fractional seconds.
    static func date(_ text: String) throws -> Date {
        if let date = try? Date(text, strategy: .iso8601) { return date }
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        throw PhoneError("\(text) is not an ISO 8601 date and time with its UTC offset.")
    }
}
