import Testing

@testable import Golem

/// Messages of one author in a row show one avatar and name, as Slack groups them.
@Suite("Message grouping")
struct MessageRowTests {
    private func message(_ author: String, agent: Bool = false, at minutes: Double, work: Work? = nil) -> Message {
        Message(
            id: "\(author)\(minutes)", authorId: nil, author: author, agent: agent, text: "", time: minutes * 60_000,
            failed: false, streaming: false, files: [], work: work)
    }

    @Test func aMessageContinuesTheSameAuthorsWithinFiveMinutes() {
        #expect(MessageRow.continues(message("Alice", at: 4), after: message("Alice", at: 0)))
        #expect(!MessageRow.continues(message("Alice", at: 5), after: message("Alice", at: 0)))
        #expect(!MessageRow.continues(message("Bob", at: 1), after: message("Alice", at: 0)))
        #expect(!MessageRow.continues(message("Golem", agent: true, at: 1), after: message("Golem", at: 0)))
    }

    @Test func aMessageWithWorkHeadsItsOwnGroup() {
        let work = Work(startedAt: 0, endedAt: 1, stopped: false, steps: [])
        #expect(!MessageRow.continues(
            message("Golem", agent: true, at: 1, work: work), after: message("Golem", agent: true, at: 0)))
    }

    @Test func golemsFaceShowsHowItsWorkGoes() {
        let working = message("Golem", agent: true, at: 0, work: Work(startedAt: 0, endedAt: nil, stopped: false, steps: []))
        let done = message("Golem", agent: true, at: 0, work: Work(startedAt: 0, endedAt: 1, stopped: false, steps: []))
        #expect(MessageRow.mood(of: working, waiting: false) == .working)
        #expect(MessageRow.mood(of: working, waiting: true) == .waiting)
        #expect(MessageRow.mood(of: done, waiting: false) == .done)
        let stopped = message("Golem", agent: true, at: 0, work: Work(startedAt: 0, endedAt: 1, stopped: true, steps: []))
        #expect(MessageRow.mood(of: stopped, waiting: false) == nil)
        #expect(MessageRow.mood(of: message("Golem", agent: true, at: 0), waiting: false) == nil)
    }

    @Test func aTurnThatAnotherThreadStartedContinuesGolemsMessage() {
        let relay = Step(
            kind: "tool", text: "[SVJ Rokycanova 8](thread:s-1)", tool: "from_thread", input: nil, output: nil,
            running: false, failed: false)
        let relayed = message(
            "Golem", agent: true, at: 30, work: Work(startedAt: 0, endedAt: 1, stopped: false, steps: [relay]))
        #expect(MessageRow.continues(relayed, after: message("Golem", agent: true, at: 0)))
        #expect(!MessageRow.continues(relayed, after: message("Vojta", at: 29)))
        #expect(MessageRow.relayedFrom(relayed) == "SVJ Rokycanova 8")
    }
}
