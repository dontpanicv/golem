import Foundation
import Testing

@testable import Golem

/// Upcoming puts what needs the person first, then the suggestions, then routines and reminders by day, soonest
/// first, then the reminders that wait for a place, then the routines at a place, then the paused routines.
@Suite("Upcoming groups")
struct UpcomingTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()
    /// Saturday 31 October 2026, 10:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_793_440_800)

    private func hours(_ hours: Double) -> Double { (now.timeIntervalSince1970 + hours * 3600) * 1000 }

    private func routine(
        _ id: String, at next: Double?, enabled: Bool = true, outcome: RoutineRun.Outcome? = nil,
        place: RoutinePlace? = nil
    ) -> Routine {
        let run = outcome.map {
            RoutineRun(
                id: "run", routineId: id, routineName: id, startedAt: 0, finishedAt: 0, outcome: $0, error: nil
            )
        }
        return Routine(
            id: id, channelId: "general", name: id, schedule: place == nil ? "0 8 * * *" : nil, place: place,
            instructions: "", script: nil, enabled: enabled, nextRunAt: enabled ? next : nil, threadId: nil,
            lastRun: run
        )
    }

    private func reminder(
        _ id: String, at due: Double, place: ReminderPlace? = nil, from: Double? = nil, until: Double? = nil
    ) -> Reminder {
        Reminder(
            id: id, threadId: "thread", recipientId: "me", createdBy: "me", text: id, dueAt: due, timeZone: "UTC",
            place: place, triggeredAt: nil, notBefore: from, notAfter: until, deliveredAt: nil, cancelledAt: nil
        )
    }

    @Test func aPlaceReminderShowsItsWindow() {
        let office = ReminderPlace(id: "office", name: "Office", latitude: 0, longitude: 0, radius: 100, event: .arrive)
        #expect(reminder("plain", at: 0, place: office).placeWindow == "Arrive at Office")
        let window = reminder("monday", at: 0, place: office, from: hours(30), until: hours(36)).placeWindow ?? ""
        #expect(window.hasPrefix("Arrive at Office · from "))
        #expect(window.contains(" · until "))
    }

    private func names(_ groups: [UpcomingGroup]) -> [String: [String]] {
        Dictionary(uniqueKeysWithValues: groups.map { ($0.kind.rawValue, $0.items.map(\.id)) })
    }

    @Test func groupsComeInOrderAndOnlyWithItems() {
        let approval = Approval(
            id: "allow", tool: "hands_exec", text: "Run", approverId: nil, allowsTurn: true, expiresAt: 0
        )
        let suggestion = Suggestion(
            id: "idea", kind: .reminder, name: "Call", text: "Call", schedule: nil, time: hours(30), channelId: "general",
            threadId: "thread", createdAt: 0
        )
        let upcoming = Upcoming(
            routines: [
                routine("weekly", at: hours(24 * 9)),
                routine("broken", at: hours(1), outcome: .failed),
                routine("stopped", at: nil, enabled: false),
                routine("morning", at: hours(22), outcome: .posted),
                routine(
                    "heating", at: nil,
                    place: RoutinePlace(
                        id: "cottage", name: "Cottage", latitude: 49.1, longitude: 16.2, radius: 300, event: .leave,
                        personId: "me"
                    )
                ),
            ],
            reminders: [
                reminder("soon", at: hours(1)), reminder("friday", at: hours(24 * 5)), reminder("now", at: hours(-1)),
                reminder(
                    "tent", at: hours(-2),
                    place: ReminderPlace(
                        id: "cottage", name: "Cottage", latitude: 49.1, longitude: 16.2, radius: 300, event: .arrive
                    )
                ),
            ],
            suggestions: [suggestion],
            approvals: [WaitingApproval(threadId: "thread", approval: approval)]
        )

        let groups = upcoming.groups(now: now, calendar: calendar)

        #expect(groups.map(\.kind) == [.needsYou, .suggested, .today, .tomorrow, .thisWeek, .later, .atPlace, .routinesAtPlace, .paused])
        #expect(names(groups) == [
            "Needs you": ["approval:allow", "routine:broken"],
            "Suggested": ["suggestion:idea"],
            "Today": ["reminder:now", "reminder:soon"],
            "Tomorrow": ["routine:morning"],
            "This week": ["reminder:friday"],
            "Later": ["routine:weekly"],
            "At a place": ["reminder:tent"],
            "Routines at a place": ["routine:heating"],
            "Paused": ["routine:stopped"],
        ])
    }

    @Test func nothingUpcomingHasNoGroups() {
        let upcoming = Upcoming(routines: [], reminders: [], suggestions: [], approvals: [])
        #expect(upcoming.groups(now: now, calendar: calendar).isEmpty)
    }
}
