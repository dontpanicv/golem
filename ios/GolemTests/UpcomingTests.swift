import Foundation
import Testing

@testable import Golem

/// Upcoming puts what needs the person first, then the suggestions, then routines and reminders by day, soonest
/// first, then the paused routines.
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
        _ id: String, at next: Double?, enabled: Bool = true, outcome: RoutineRun.Outcome? = nil
    ) -> Routine {
        let run = outcome.map {
            RoutineRun(
                id: "run", routineId: id, routineName: id, startedAt: 0, finishedAt: 0, outcome: $0, error: nil
            )
        }
        return Routine(
            id: id, channelId: "general", name: id, schedule: "0 8 * * *", instructions: "", script: nil,
            enabled: enabled, nextRunAt: enabled ? next : nil, threadId: nil, lastRun: run
        )
    }

    private func reminder(_ id: String, at due: Double) -> Reminder {
        Reminder(
            id: id, threadId: "thread", recipientId: "me", createdBy: "me", text: id, dueAt: due, timeZone: "UTC",
            deliveredAt: nil, cancelledAt: nil
        )
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
            ],
            reminders: [reminder("soon", at: hours(1)), reminder("friday", at: hours(24 * 5)), reminder("now", at: hours(-1))],
            suggestions: [suggestion],
            approvals: [WaitingApproval(threadId: "thread", approval: approval)]
        )

        let groups = upcoming.groups(now: now, calendar: calendar)

        #expect(groups.map(\.kind) == [.needsYou, .suggested, .today, .tomorrow, .thisWeek, .later, .paused])
        #expect(names(groups) == [
            "Needs you": ["approval:allow", "routine:broken"],
            "Suggested": ["suggestion:idea"],
            "Today": ["reminder:now", "reminder:soon"],
            "Tomorrow": ["routine:morning"],
            "This week": ["reminder:friday"],
            "Later": ["routine:weekly"],
            "Paused": ["routine:stopped"],
        ])
    }

    @Test func nothingUpcomingHasNoGroups() {
        let upcoming = Upcoming(routines: [], reminders: [], suggestions: [], approvals: [])
        #expect(upcoming.groups(now: now, calendar: calendar).isEmpty)
    }
}
