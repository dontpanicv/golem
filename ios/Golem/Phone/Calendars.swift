import EventKit
import Foundation

/// Apple Reminders and the calendars on the phone (EventKit), with every account that the person added to them.
enum Calendars {
    private struct ListsArguments: Decodable {
        let list: String?
        let completed: Bool?
        let limit: Int?
    }

    private struct ReminderArguments: Decodable {
        let id: String?
        let title: String?
        let list: String?
        let due: String?
        let notes: String?
        let priority: String?
        let completed: Bool?
    }

    private struct EventsArguments: Decodable {
        let from: String
        let to: String
        let calendar: String?
    }

    private struct EventArguments: Decodable {
        let id: String?
        let title: String?
        let start: String?
        let end: String?
        let allDay: Bool?
        let calendar: String?
        let location: String?
        let notes: String?
        let alertMinutes: Int?
    }

    private struct IdArguments: Decodable {
        let id: String
    }

    private struct List: Encodable {
        let name: String
        let account: String
        let writable: Bool
        let isDefault: Bool
    }

    private struct ReminderRow: Encodable, Sendable {
        let id: String
        let title: String
        let list: String
        let due: Date?
        let notes: String?
        let priority: String
        let completed: Bool
    }

    private struct EventRow: Encodable {
        let id: String
        let title: String
        let start: Date
        let end: Date
        let allDay: Bool
        let calendar: String
        let location: String?
        let notes: String?
        let repeats: Bool
    }

    private static let store = EKEventStore()

    // MARK: Reminders

    static func reminderLists(_: PhoneCall) async throws -> PhoneAnswer {
        try await access(.reminder)
        return try .json(lists(.reminder, default: store.defaultCalendarForNewReminders()))
    }

    static func reminders(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(ListsArguments.self)
        try await access(.reminder)
        let calendars = try arguments.list.map { [try calendar(named: $0, .reminder)] }
        let predicate = arguments.completed == true
            ? store.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: calendars)
            : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars)
        let rows = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: (reminders ?? []).map(row))
            }
        }
        return try .json(Array(rows.prefix(arguments.limit ?? 200)))
    }

    static func addReminder(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(ReminderArguments.self)
        try await access(.reminder)
        let reminder = EKReminder(eventStore: store)
        reminder.calendar = try arguments.list.map { try calendar(named: $0, .reminder) }
            ?? store.defaultCalendarForNewReminders()
        try apply(arguments, to: reminder)
        try store.save(reminder, commit: true)
        return PhoneAnswer(text: "Added to \(reminder.calendar.title), id \(reminder.calendarItemIdentifier).")
    }

    static func changeReminder(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(ReminderArguments.self)
        try await access(.reminder)
        let reminder = try self.reminder(arguments.id ?? "")
        try apply(arguments, to: reminder)
        try store.save(reminder, commit: true)
        return try .json(row(reminder))
    }

    static func deleteReminder(_ call: PhoneCall) async throws -> PhoneAnswer {
        let id = try call.arguments(IdArguments.self).id
        try await access(.reminder)
        try store.remove(try reminder(id), commit: true)
        return PhoneAnswer(text: "Deleted.")
    }

    private static func reminder(_ id: String) throws -> EKReminder {
        guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw PhoneError("There is no reminder \(id).")
        }
        return reminder
    }

    private static func apply(_ arguments: ReminderArguments, to reminder: EKReminder) throws {
        if let title = arguments.title { reminder.title = title }
        if let notes = arguments.notes { reminder.notes = notes }
        if let completed = arguments.completed { reminder.isCompleted = completed }
        if let priority = arguments.priority {
            let values = ["none": 0, "high": 1, "medium": 5, "low": 9]
            guard let value = values[priority] else { throw PhoneError("priority must be none, low, medium, or high.") }
            reminder.priority = value
        }
        if let due = arguments.due {
            let date = try PhoneLink.date(due)
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.calendar, .timeZone, .year, .month, .day, .hour, .minute], from: date
            )
            reminder.alarms = [EKAlarm(absoluteDate: date)]
        }
    }

    nonisolated private static func row(_ reminder: EKReminder) -> ReminderRow {
        let priority = switch reminder.priority {
        case 1...4: "high"
        case 5: "medium"
        case 6...9: "low"
        default: "none"
        }
        return ReminderRow(
            id: reminder.calendarItemIdentifier,
            title: reminder.title ?? "",
            list: reminder.calendar?.title ?? "",
            due: reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) },
            notes: reminder.notes,
            priority: priority,
            completed: reminder.isCompleted
        )
    }

    // MARK: Calendar

    static func calendars(_: PhoneCall) async throws -> PhoneAnswer {
        try await access(.event)
        return try .json(lists(.event, default: store.defaultCalendarForNewEvents))
    }

    static func events(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(EventsArguments.self)
        try await access(.event)
        let calendars = try arguments.calendar.map { [try calendar(named: $0, .event)] }
        let predicate = store.predicateForEvents(
            withStart: try PhoneLink.date(arguments.from), end: try PhoneLink.date(arguments.to), calendars: calendars
        )
        return try .json(store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.map(row))
    }

    static func addEvent(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(EventArguments.self)
        try await access(.event)
        let event = EKEvent(eventStore: store)
        event.calendar = try arguments.calendar.map { try calendar(named: $0, .event) } ?? store.defaultCalendarForNewEvents
        try apply(arguments, to: event)
        if let minutes = arguments.alertMinutes { event.addAlarm(EKAlarm(relativeOffset: -Double(minutes) * 60)) }
        try store.save(event, span: .thisEvent, commit: true)
        return try .json(row(event))
    }

    static func changeEvent(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(EventArguments.self)
        try await access(.event)
        let event = try self.event(arguments.id ?? "")
        try apply(arguments, to: event)
        try store.save(event, span: .thisEvent, commit: true)
        return try .json(row(event))
    }

    static func deleteEvent(_ call: PhoneCall) async throws -> PhoneAnswer {
        let id = try call.arguments(IdArguments.self).id
        try await access(.event)
        try store.remove(try event(id), span: .thisEvent, commit: true)
        return PhoneAnswer(text: "Deleted.")
    }

    private static func apply(_ arguments: EventArguments, to event: EKEvent) throws {
        if let title = arguments.title { event.title = title }
        if let start = arguments.start { event.startDate = try PhoneLink.date(start) }
        if let end = arguments.end { event.endDate = try PhoneLink.date(end) }
        if let allDay = arguments.allDay { event.isAllDay = allDay }
        if let location = arguments.location { event.location = location }
        if let notes = arguments.notes { event.notes = notes }
        guard event.startDate != nil, event.endDate != nil else { throw PhoneError("Give start and end.") }
    }

    /// The occurrence that an id names: all occurrences of a repeating event share its identifier, so the id adds
    /// the occurrence's start, in Unix seconds, after an `@`.
    private static func event(_ id: String) throws -> EKEvent {
        let parts = id.split(separator: "@", omittingEmptySubsequences: false)
        if parts.count > 1, let seconds = Double(parts.last!) {
            let identifier = parts.dropLast().joined(separator: "@")
            let start = Date(timeIntervalSince1970: seconds)
            let predicate = store.predicateForEvents(
                withStart: start.addingTimeInterval(-60), end: start.addingTimeInterval(60), calendars: nil
            )
            if let event = store.events(matching: predicate).first(where: {
                $0.eventIdentifier == identifier && abs($0.occurrenceDate.timeIntervalSince(start)) < 1
            }) {
                return event
            }
        }
        guard let event = store.event(withIdentifier: id) else { throw PhoneError("There is no event \(id).") }
        return event
    }

    private static func row(_ event: EKEvent) -> EventRow {
        let repeats = event.hasRecurrenceRules
        return EventRow(
            id: repeats
                ? "\(event.eventIdentifier ?? "")@\(Int(event.occurrenceDate.timeIntervalSince1970))"
                : event.eventIdentifier ?? "",
            title: event.title ?? "",
            start: event.startDate,
            end: event.endDate,
            allDay: event.isAllDay,
            calendar: event.calendar?.title ?? "",
            location: event.location,
            notes: event.notes,
            repeats: repeats
        )
    }

    // MARK: Shared

    private static func lists(_ type: EKEntityType, default chosen: EKCalendar?) -> [List] {
        store.calendars(for: type).map {
            List(
                name: $0.title,
                account: $0.source?.title ?? "",
                writable: $0.allowsContentModifications,
                isDefault: $0.calendarIdentifier == chosen?.calendarIdentifier
            )
        }
    }

    private static func calendar(named name: String, _ type: EKEntityType) throws -> EKCalendar {
        let calendars = store.calendars(for: type)
        guard let found = calendars.first(where: { $0.title.localizedCaseInsensitiveCompare(name) == .orderedSame })
        else {
            throw PhoneError("There is no \(name). Name one of: \(calendars.map(\.title).joined(separator: ", ")).")
        }
        return found
    }

    private static func access(_ type: EKEntityType) async throws {
        if EKEventStore.authorizationStatus(for: type) == .fullAccess { return }
        let allowed = type == .reminder
            ? try await store.requestFullAccessToReminders()
            : try await store.requestFullAccessToEvents()
        guard allowed else {
            let name = type == .reminder ? "Reminders" : "Calendars"
            throw PhoneError("The person did not allow Golem to use \(name): Settings › Apps › Golem › \(name).")
        }
    }
}
