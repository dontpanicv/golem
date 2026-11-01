import AlarmKit
import SwiftUI

/// Alarms and timers that ring like the Clock app's, also in silent mode (AlarmKit). iOS does not show the Clock
/// app's own alarms to other apps, so these tools see only the ones that Golem set.
enum Alarms {
    private struct SetArguments: Decodable {
        let label: String
        let time: String?
        let weekdays: [String]?
        let at: String?
    }

    private struct TimerArguments: Decodable {
        let label: String
        let seconds: Int
    }

    private struct ChangeArguments: Decodable {
        let id: String
        let action: String
    }

    private struct Listed: Encodable {
        let id: String
        let label: String?
        let state: String
        /// HH:MM of an alarm at a time of day, and the weekdays on which it repeats.
        let time: String?
        let weekdays: [String]?
        /// An alarm at one date.
        let at: Date?
        /// A timer's length.
        let seconds: Double?
    }

    private static let labelsKey = "phoneAlarmLabels"
    private static let weekdays: [(String, Locale.Weekday)] = [
        ("monday", .monday), ("tuesday", .tuesday), ("wednesday", .wednesday), ("thursday", .thursday),
        ("friday", .friday), ("saturday", .saturday), ("sunday", .sunday),
    ]

    static func set(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(SetArguments.self)
        let schedule: Alarm.Schedule
        if let at = arguments.at {
            schedule = .fixed(try PhoneLink.date(at))
        } else if let time = arguments.time {
            let parts = time.split(separator: ":").compactMap { Int($0) }
            guard parts.count == 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else {
                throw PhoneError("time must be HH:MM, such as 06:30.")
            }
            let days = try (arguments.weekdays ?? []).map { name in
                guard let day = weekdays.first(where: { $0.0 == name })?.1 else {
                    throw PhoneError("\(name) is not a weekday.")
                }
                return day
            }
            schedule = .relative(.init(
                time: .init(hour: parts[0], minute: parts[1]), repeats: days.isEmpty ? .never : .weekly(days)
            ))
        } else {
            throw PhoneError("Give time or at.")
        }
        let id = try await add(arguments.label, .alarm(schedule: schedule, attributes: attributes(arguments.label)))
        return PhoneAnswer(text: "Alarm set, id \(id).")
    }

    static func startTimer(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(TimerArguments.self)
        let id = try await add(
            arguments.label,
            .timer(duration: TimeInterval(arguments.seconds), attributes: attributes(arguments.label))
        )
        return PhoneAnswer(text: "Timer started, id \(id).")
    }

    static func list(_: PhoneCall) async throws -> PhoneAnswer {
        try await authorize()
        let alarms = try AlarmManager.shared.alarms
        // Labels of alarms that rang or were cancelled go.
        labels = labels.filter { id, _ in alarms.contains { $0.id.uuidString == id } }
        return try .json(alarms.map { alarm in
            var time: String?, days: [String]?, at: Date?
            switch alarm.schedule {
            case let .relative(relative):
                time = String(format: "%02d:%02d", relative.time.hour, relative.time.minute)
                if case let .weekly(repeats) = relative.repeats {
                    days = weekdays.filter { repeats.contains($0.1) }.map(\.0)
                }
            case let .fixed(date):
                at = date
            default:
                break
            }
            return Listed(
                id: alarm.id.uuidString,
                label: labels[alarm.id.uuidString],
                state: "\(alarm.state)",
                time: time,
                weekdays: days,
                at: at,
                seconds: alarm.countdownDuration?.preAlert
            )
        })
    }

    static func change(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(ChangeArguments.self)
        guard let id = UUID(uuidString: arguments.id) else { throw PhoneError("\(arguments.id) is not an alarm id.") }
        try await authorize()
        let manager = AlarmManager.shared
        switch arguments.action {
        case "cancel": try manager.cancel(id: id)
        case "stop": try manager.stop(id: id)
        case "pause": try manager.pause(id: id)
        case "resume": try manager.resume(id: id)
        default: throw PhoneError("action must be cancel, stop, pause, or resume.")
        }
        return PhoneAnswer(text: "Done: \(arguments.action).")
    }

    private static func add(
        _ label: String, _ configuration: sending AlarmManager.AlarmConfiguration<GolemAlarm>
    ) async throws -> UUID {
        try await authorize()
        let id = UUID()
        _ = try await AlarmManager.shared.schedule(id: id, configuration: configuration)
        labels[id.uuidString] = label
        return id
    }

    private static func attributes(_ label: String) -> AlarmAttributes<GolemAlarm> {
        let title = LocalizedStringResource(stringLiteral: label)
        return AlarmAttributes(
            presentation: AlarmPresentation(
                alert: .init(title: title),
                countdown: .init(
                    title: title,
                    pauseButton: AlarmButton(text: "Pause", textColor: .white, systemImageName: "pause.fill")
                ),
                paused: .init(
                    title: title,
                    resumeButton: AlarmButton(text: "Resume", textColor: .white, systemImageName: "play.fill")
                )
            ),
            metadata: GolemAlarm(label: label),
            tintColor: Tokens.Colors.accent
        )
    }

    private static func authorize() async throws {
        let manager = AlarmManager.shared
        if manager.authorizationState == .authorized { return }
        if manager.authorizationState == .notDetermined, try await manager.requestAuthorization() == .authorized {
            return
        }
        throw PhoneError("The person did not allow Golem to set alarms: Settings › Apps › Golem › Alarms & Timers.")
    }

    /// The label of each alarm by id: iOS gives an alarm's schedule and state, not its label.
    private static var labels: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: labelsKey) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: labelsKey) }
    }
}
