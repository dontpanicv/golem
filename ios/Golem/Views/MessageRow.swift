import SwiftUI
import UniformTypeIdentifiers

/// One message, as Slack shows it: the author's avatar at the side, their name and the time over the text. A message
/// that follows one of the same author within five minutes shows only its text (``continues(_:after:)``).
struct MessageRow: View {
    let message: Message
    var continued = false
    let openFile: (FileRef) -> Void
    @Environment(Session.self) private var session

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.lg) {
            if continued {
                Color.clear.frame(width: Tokens.Mobile.Size.avatar, height: 1)
            } else if message.agent {
                GolemMark(size: Tokens.Mobile.Size.avatar)
            } else {
                Avatar(name: message.author, size: Tokens.Mobile.Size.avatar)
            }
            VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                if !continued {
                    HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.sm) {
                        Text(message.author)
                            .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.semibold))
                            .foregroundStyle(Tokens.Mobile.Colors.title)
                        Text(Date(milliseconds: message.time), format: .dateTime.hour().minute())
                            .font(.golem(Tokens.Mobile.FontSize.caption))
                            .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                    }
                }
                if let work = message.work { WorkLog(work: work) }
                if !message.text.isEmpty {
                    MarkdownText(text: message.text, size: Tokens.Mobile.FontSize.body, working: session.working)
                        .foregroundStyle(message.failed ? Tokens.Mobile.Colors.danger : Tokens.Mobile.Colors.text)
                        .textSelection(.enabled)
                }
                ForEach(message.files.filter(\.isPicture)) { file in
                    FilePicture(file: file) { openFile(file) }
                }
                let others = message.files.filter { !$0.isPicture }
                if !others.isEmpty {
                    FileChips(names: others.map(\.name)) { openFile(others[$0]) }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// The message follows one of the same author within five minutes, and has no work log to head.
    static func continues(_ message: Message, after previous: Message) -> Bool {
        message.author == previous.author && message.agent == previous.agent && message.work == nil
            && message.time - previous.time < 5 * 60 * 1000
    }

    /// One line of text with its inline Markdown (bold, italics, code, links) and each thread link the agent wrote,
    /// `[title](thread:<id>)`, as a link to `thread:<id>`, followed by "working" while the agent of that thread works.
    static func linked(_ text: String, working: Set<String> = []) -> AttributedString {
        var result = AttributedString()
        var rest = text[...]
        while let match = rest.firstMatch(of: /\[([^\]\n]+)\]\(thread:([\w-]+)\)/) {
            result += markdown(rest[..<match.range.lowerBound])
            var link = AttributedString(match.1)
            link.link = URL(string: "thread:\(match.2)")
            link.foregroundColor = Tokens.Colors.accent
            result += link
            if working.contains(String(match.2)) {
                var note = AttributedString(" · working")
                note.foregroundColor = Tokens.Colors.textTertiary
                result += note
            }
            rest = rest[match.range.upperBound...]
        }
        return result + markdown(rest)
    }

    /// Inline Markdown, keeping the line breaks; links take the accent.
    private static func markdown(_ text: Substring) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var result = (try? AttributedString(markdown: String(text), options: options)) ?? AttributedString(text)
        for run in result.runs where run.link != nil { result[run.range].foregroundColor = Tokens.Colors.accent }
        return result
    }
}

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
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let end = work.endedAt.map { Date(milliseconds: $0) } ?? context.date
                        Text(label(Self.duration(end.timeIntervalSince(Date(milliseconds: work.startedAt)))))
                            .monospacedDigit()
                    }
                    if !work.steps.isEmpty {
                        Image(systemName: "chevron.right").imageScale(.small).rotationEffect(.degrees(open ? 90 : 0))
                    }
                }
                .font(.golem(Tokens.FontSize.md))
                .foregroundStyle(Tokens.Colors.textTertiary)
                .frame(minHeight: Tokens.Size.listRow)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
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
        return work.stopped ? "Stopped after \(span)" : "Worked for \(span)"
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
                        if step.running { ProgressView().controlSize(.mini) }
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
                .textSelection(.enabled)
        }
    }

    /// A tool call's arguments and result, when it has them.
    private var details: [String] {
        [step.input, step.output].compactMap { $0 }.filter { !$0.isEmpty && $0 != "{}" }
    }
}

extension FileRef {
    var isPicture: Bool {
        UTType(filenameExtension: (name as NSString).pathExtension)?.conforms(to: .image) ?? false
    }
}

/// A picture of a message, from its JPEG, at most 320 wide and 240 high; a tap opens it. A picture that the server
/// cannot convert shows as a chip.
private struct FilePicture: View {
    let file: FileRef
    let open: () -> Void
    @Environment(Session.self) private var session
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Button(action: open) {
            if failed {
                FileChip(name: file.name)
            } else if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 320, maxHeight: 240)
                    .clipShape(.rect(cornerRadius: Tokens.Radius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: Tokens.Radius.md)
                            .strokeBorder(Tokens.Colors.ring, lineWidth: 0.5)
                    )
            } else {
                RoundedRectangle(cornerRadius: Tokens.Radius.md)
                    .fill(Tokens.Colors.fillSubtle)
                    .frame(width: 180, height: 135)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(file.name)
        .task(id: file.id) {
            guard image == nil, let workspaceID = session.workspace?.id else { return }
            do {
                image = UIImage(data: try await session.api.picture(workspaceID: workspaceID, fileID: file.id))
                failed = image == nil
            } catch {
                // The row left the screen; it loads again when it comes back.
                failed = !Task.isCancelled
            }
        }
    }
}
