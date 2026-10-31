import SwiftUI

/// The use of the model in the last 30 days: the person's own, or everyone's for the server's owner. The cost is at
/// the model's list price, which a ChatGPT login does not pay.
struct UsageSection: View {
    let workspaceID: String
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var usage: Usage?

    private static let days = 30

    var body: some View {
        SettingsCard(title: "Usage") {
            if let usage {
                SettingsRow("Tokens", description: "Last \(Self.days) days") { value(tokens(usage.total.tokens)) }
                SettingsRow("Cost at API prices") { value(cost(usage.total.cost)) }
                SettingsRow("Cache rate") {
                    value(usage.total.cacheRate.formatted(.percent.precision(.fractionLength(0))))
                }
                DayBars(days: usage.days, count: Self.days)
                    .padding(.horizontal, Tokens.Mobile.Size.margin)
                    .padding(.vertical, Tokens.Space.md)
                group("Sources", usage.sources) { sourceName($0.source) }
                group("Models", usage.models) { modelName($0.model) }
                if !usage.threads.isEmpty {
                    ListSectionHeader(title: "Threads")
                    ForEach(usage.threads, id: \.threadId) { thread in
                        Button { thread.threadId.map { open(.thread($0)) } } label: {
                            SettingsRow(thread.title ?? "", description: "\(tokens(thread.tokens)) tokens") {
                                value(cost(thread.cost))
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.row)
                    }
                }
                if let people = usage.people { group("People", people) { $0.name ?? "" } }
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: Tokens.Size.settingsRow)
            }
        }
        .task { await session.run { usage = try await session.api.usage(workspaceID: workspaceID, days: Self.days) } }
    }

    @ViewBuilder
    private func group(_ title: String, _ rows: [UsageTotals], name: @escaping (UsageTotals) -> String) -> some View {
        if !rows.isEmpty {
            ListSectionHeader(title: title)
            ForEach(rows, id: \.self) { row in
                SettingsRow(name(row), description: "\(tokens(row.tokens)) tokens") { value(cost(row.cost)) }
            }
        }
    }

    private func value(_ text: String) -> some View {
        Text(text)
            .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book))
            .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
            .monospacedDigit()
    }

    private func tokens(_ count: Double) -> String { count.formatted(.number.notation(.compactName)) }

    private func cost(_ dollars: Double) -> String {
        dollars.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }

    private func sourceName(_ source: String?) -> String {
        switch source {
        case "thread": "Threads"
        case "orchestrator": "Golem"
        case "routine": "Routines"
        case "reminder": "Reminders"
        case "background": "Briefs, memory, and names"
        default: source ?? ""
        }
    }

    /// "provider/model", or "tool:<name>" for a tool's own model calls.
    private func modelName(_ model: String?) -> String {
        guard let model else { return "" }
        return model.hasPrefix("tool:") ? "Tool \(model.dropFirst(5))" : model
    }
}

/// A small bar for each of the last `count` days in UTC, as tall as its tokens; a day without use has no bar.
private struct DayBars: View {
    let days: [UsageTotals]
    let count: Int

    var body: some View {
        let tokens = Self.lastDays(count).map { day in days.first { $0.day == day }?.tokens ?? 0 }
        let most = max(tokens.max() ?? 0, 1)
        HStack(alignment: .bottom, spacing: Tokens.Space.xxs) {
            ForEach(Array(tokens.enumerated()), id: \.offset) { _, value in
                RoundedRectangle(cornerRadius: Tokens.Radius.xxs)
                    .fill(value > 0 ? Tokens.Colors.accent : Tokens.Mobile.Colors.fill)
                    .frame(height: max(Tokens.Space.xxs, Tokens.Size.control * value / most))
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(height: Tokens.Size.control, alignment: .bottom)
        .accessibilityElement()
        .accessibilityLabel("Tokens by day")
    }

    /// "YYYY-MM-DD" of the last `count` days in UTC, oldest first, as the server names its days.
    static func lastDays(_ count: Int) -> [String] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let format = Date.ISO8601FormatStyle(timeZone: .gmt).year().month().day()
        return (0..<count).reversed().compactMap { back in
            calendar.date(byAdding: .day, value: -back, to: .now)?.formatted(format)
        }
    }
}
