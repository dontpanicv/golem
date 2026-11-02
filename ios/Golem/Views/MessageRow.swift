import SwiftUI
import UniformTypeIdentifiers

/// One message, as Slack shows it: the author's avatar at the side, their name and the time over the text. A message
/// that follows one of the same author within five minutes shows only its text (``continues(_:after:)``). Golem's face
/// shows the mood of its answer; `waiting` says that it waits for a person to allow an action of this answer's work.
struct MessageRow: View {
    let message: Message
    var continued = false
    var waiting = false
    let openFile: (FileRef) -> Void
    @Environment(Session.self) private var session

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Space.lg) {
            if continued {
                Color.clear.frame(width: Tokens.Mobile.Size.avatar, height: 1)
            } else if message.agent {
                if let mood = Self.mood(of: message, waiting: waiting) {
                    GolemFace(mood: mood, size: Tokens.Mobile.Size.avatar)
                } else {
                    GolemMark(size: Tokens.Mobile.Size.avatar)
                }
            } else {
                PersonAvatar(
                    name: message.author,
                    picture: message.authorId.flatMap { session.pictures[$0] },
                    size: Tokens.Mobile.Size.avatar
                )
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
                        // Selectable text tapped its links at other places than it drew them, so most taps missed.
                        .contextMenu {
                            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                        }
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

    /// The face of an agent's message: it failed, it works or waits for a person, or it finished its work; an answer
    /// with no work, or one that a person stopped, has the icon's own face.
    static func mood(of message: Message, waiting: Bool) -> GolemFace.Mood? {
        if message.failed { return .failed }
        if message.streaming || (message.work != nil && message.work?.endedAt == nil) {
            return waiting ? .waiting : .working
        }
        return message.work.map { $0.stopped ? nil : .done } ?? nil
    }

    /// The message follows one of the same author within five minutes, and has no work log to head; or it is a turn of
    /// Golem that the answer of another thread started, such as the result of work that the message before asked for.
    static func continues(_ message: Message, after previous: Message) -> Bool {
        if message.agent, previous.agent, relayedFrom(message) != nil { return true }
        return message.author == previous.author && message.agent == previous.agent && message.work == nil
            && message.time - previous.time < 5 * 60 * 1000
    }

    /// The title of the thread whose message started this turn, or nil for a turn that a person started.
    static func relayedFrom(_ message: Message) -> String? {
        guard let first = message.work?.steps.first, first.tool == relay else { return nil }
        return String(linked(first.text).characters)
    }

    /// The step of a turn that another thread's message started.
    static let relay = "from_thread"

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
