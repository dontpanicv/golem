import SwiftUI

/// The work before an answer: open while the agent works, then folded into "Worked for …". A person's choice to open
/// or fold it lasts until the work ends. A long log scrolls and keeps its newest step in view; calls of one tool in a
/// row fold into one row.
struct WorkLog: View {
    let work: Work
    @State private var chosen: Bool?

    private var working: Bool { work.endedAt == nil }
    private var open: Bool { chosen ?? working }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.xs) {
            Button {
                withAnimation(.snappy) { chosen = !open }
            } label: {
                HStack(spacing: Tokens.Space.xs) {
                    if working { PixelSpinner().padding(.trailing, Tokens.Space.xs) }
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let end = work.endedAt.map { Date(milliseconds: $0) } ?? context.date
                        let text = Text(label(Self.duration(end.timeIntervalSince(Date(milliseconds: work.startedAt)))))
                            .monospacedDigit()
                        if working { text.modifier(Shimmer()) } else { text }
                    }
                    if working, let step = Self.stepTitle(work.steps.last) {
                        Text("· \(step)").foregroundStyle(Tokens.Colors.textQuaternary).lineLimit(1)
                    }
                    if !work.steps.isEmpty {
                        Image(systemName: "chevron.right").imageScale(.small).rotationEffect(.degrees(open ? 90 : 0))
                    }
                    if !working { StepStrip(steps: work.steps).padding(.leading, Tokens.Space.xs) }
                }
                .font(.golem(Tokens.FontSize.md))
                .foregroundStyle(Tokens.Colors.textTertiary)
                .frame(minHeight: Tokens.Size.listRow)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            // The 44 pt touch target reaches over the lines around it, so the summary sits as close as a line.
            .padding(.vertical, -(Tokens.Size.listRow - 20) / 2)
            .disabled(work.steps.isEmpty)
            if open, !work.steps.isEmpty {
                ViewThatFits(in: .vertical) {
                    steps
                    ScrollView { steps }.defaultScrollAnchor(.bottom, for: .sizeChanges)
                }
                .frame(maxHeight: Tokens.Size.workLog)
                .padding(.leading, Tokens.Space.md)
                .overlay(alignment: .leading) { Rectangle().fill(Tokens.Colors.border).frame(width: 1) }
            }
        }
        .animation(.snappy, value: working)
        .onChange(of: working) { chosen = nil }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.xs) {
            ForEach(Self.runs(work.steps), id: \.start) { run in
                if run.steps.count == 1 {
                    WorkStep(step: run.steps[0])
                } else {
                    WorkGroup(steps: run.steps)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(_ span: String) -> String {
        if working { return "Working for \(span)" }
        if work.stopped { return "Stopped after \(span)" }
        if work.steps.first?.tool == MessageRow.relay, let first = work.steps.first {
            return "From \(String(MessageRow.linked(first.text).characters))"
        }
        return "Worked for \(span)"
    }

    /// The step the agent is at: the tool it calls, a thought, or the words of its answer.
    static func stepTitle(_ step: Step?) -> String? {
        guard let step else { return nil }
        switch step.kind {
        case "tool": return toolName(step.tool)
        case "thinking": return "Thinking"
        default: return "Writing"
        }
    }

    /// The steps in runs: each call of a tool that the call before it also made joins that call's run.
    static func runs(_ steps: [Step]) -> [(start: Int, steps: [Step])] {
        var result: [(start: Int, steps: [Step])] = []
        for (index, step) in steps.enumerated() {
            if step.kind == "tool", let last = result.last, last.steps[0].tool == step.tool {
                result[result.count - 1].steps.append(step)
            } else {
                result.append((index, [step]))
            }
        }
        return result
    }

    /// A time span as 8s, 2m 05s, or 1h 03m, as the web writes it.
    static func duration(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval))
        let minutes = seconds / 60
        if minutes == 0 { return "\(seconds)s" }
        if minutes < 60 { return "\(minutes)m \(String(format: "%02d", seconds % 60))s" }
        return "\(minutes / 60)h \(String(format: "%02d", minutes % 60))m"
    }

    /// A tool's name as words: `web_search` is Web search.
    static func toolName(_ tool: String?) -> String {
        let words = (tool ?? "").replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

/// The pixel of tool calls: gold when they finished, `danger` when one failed, and the blinking accent while one runs.
private struct StepPixel: View {
    let steps: [Step]

    var body: some View {
        if steps.contains(where: \.running) {
            TimelineView(.periodic(from: .now, by: 0.5)) { context in
                Rectangle().fill(Tokens.Colors.accent)
                    .opacity(Int(context.date.timeIntervalSinceReferenceDate * 2) % 2 == 0 ? 1 : 0.25)
            }
            .frame(width: 7, height: 7)
        } else {
            Rectangle()
                .fill(steps.contains(where: \.failed) ? Tokens.Colors.danger : Tokens.Colors.gold)
                .frame(width: 7, height: 7)
        }
    }
}

/// One pixel for each tool call of a finished work, in the gold of the icon's eyes, or `danger` where a call failed.
private struct StepStrip: View {
    let steps: [Step]

    private var calls: [Step] { steps.filter { $0.kind == "tool" && $0.tool != MessageRow.relay } }

    var body: some View {
        // shortcut: a long work shows only its last 24 calls; open the log for all of them.
        HStack(spacing: 2) {
            ForEach(Array(calls.suffix(24).enumerated()), id: \.offset) { _, step in
                StepPixel(steps: [step])
            }
        }
        .accessibilityHidden(true)
    }
}

/// Calls of one tool in a row: the tool's name and how many calls, which opens to show each call. It starts open while
/// one of them runs.
struct WorkGroup: View {
    let steps: [Step]
    @State private var chosen: Bool?

    private var open: Bool { chosen ?? steps.contains(where: \.running) }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.xs) {
            Button {
                withAnimation(.snappy) { chosen = !open }
            } label: {
                HStack(spacing: Tokens.Space.sm) {
                    StepPixel(steps: steps)
                    Text(WorkLog.toolName(steps[0].tool))
                        .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
                        .foregroundStyle(Tokens.Colors.textTertiary)
                    Text("\(steps.count) times")
                        .font(.golem(Tokens.FontSize.md))
                        .foregroundStyle(Tokens.Colors.textQuaternary)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { _, step in WorkStep(step: step) }
                }
                .padding(.leading, Tokens.Space.md)
            }
        }
    }
}

/// A thought, the words between tool calls, or a tool call: its name, then the thread it reached or the values of its
/// arguments. Tapping a tool call shows its arguments and result.
struct WorkStep: View {
    let step: Step
    @State private var open = false
    @Environment(Session.self) private var session

    var body: some View {
        switch step.kind {
        case "tool":
            VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                Button { withAnimation(.snappy) { open.toggle() } } label: {
                    HStack(spacing: Tokens.Space.sm) {
                        StepPixel(steps: [step])
                        Text(WorkLog.toolName(step.tool))
                            .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
                            .foregroundStyle(step.failed ? Tokens.Colors.danger : Tokens.Colors.textTertiary)
                        Text(MessageRow.linked(step.text, working: session.working))
                            .font(.golem(Tokens.FontSize.md))
                            .foregroundStyle(Tokens.Colors.textQuaternary)
                            .lineLimit(1)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                if open {
                    ForEach(details, id: \.self) {
                        Text($0)
                            .font(.system(size: Tokens.FontSize.sm, design: .monospaced))
                            .foregroundStyle(Tokens.Colors.textTertiary)
                            .textSelection(.enabled)
                            .padding(.horizontal, Tokens.Space.md)
                            .padding(.vertical, Tokens.Space.sm)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Tokens.Colors.fillSubtle, in: .rect(cornerRadius: Tokens.Radius.sm))
                    }
                }
            }
        case "thinking":
            Text(step.text)
                .font(.golem(Tokens.FontSize.md))
                .foregroundStyle(Tokens.Colors.textQuaternary)
                .textSelection(.enabled)
        default:
            MarkdownText(text: step.text, size: Tokens.FontSize.md, working: session.working)
                .foregroundStyle(Tokens.Colors.textSecondary)
                .copyable(step.text)
        }
    }

    /// A tool call's arguments and result, when it has them.
    private var details: [String] {
        [step.input, step.output].compactMap { $0 }.filter { !$0.isEmpty && $0 != "{}" }
    }
}
