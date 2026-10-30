import SwiftUI

/// Markdown that an agent wrote, as the web shows it: headings, lists, quotes, code blocks, tables, and rules, with
/// the inline Markdown in each. A link takes the accent; a link to `thread:<id>` is followed by "working" while the
/// agent of that thread works.
///
/// ```swift
/// MarkdownText(text: "## Plan\n- Book the flight", size: Tokens.Mobile.FontSize.body)
/// ```
struct MarkdownText: View {
    let text: String
    let size: CGFloat
    var working: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.md) {
            ForEach(Array(Self.blocks(text, size: size, working: working).enumerated()), id: \.offset) { _, block in
                // Text measured at one width and placed at another loses lines, and leaves their height empty.
                view(block).fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.golem(size))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func view(_ block: Block) -> some View {
        switch block {
        case .paragraph(let text):
            Text(text)
        case .heading(let text, let level):
            Text(text)
                .font(.golem(level == 1 ? size * 1.25 : size, Tokens.FontWeight.semibold))
                .foregroundStyle(Tokens.Mobile.Colors.title)
        case .list(let items):
            VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.sm) {
                        Text(item.marker).monospacedDigit().frame(minWidth: size, alignment: .trailing)
                        Text(item.text).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.depth - 1) * Tokens.Space.xl)
                }
            }
        case .quote(let text):
            Text(text)
                .foregroundStyle(Tokens.Colors.textTertiary)
                .padding(.leading, Tokens.Space.lg)
                .overlay(alignment: .leading) { Rectangle().fill(Tokens.Colors.borderStrong).frame(width: 2) }
        case .code(let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).font(.system(size: Tokens.FontSize.md, design: .monospaced))
            }
            .padding(.horizontal, Tokens.Space.lg)
            .padding(.vertical, Tokens.Space.md)
            .background(Tokens.Colors.fillSubtle, in: .rect(cornerRadius: Tokens.Radius.md))
        case .table(let rows, let alignments):
            Grid(alignment: .leading, horizontalSpacing: Tokens.Space.lg, verticalSpacing: Tokens.Space.sm) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            Text(cell)
                                .fontWeight(index == 0 ? Tokens.FontWeight.medium : nil)
                                .foregroundStyle(index == 0 ? Tokens.Mobile.Colors.title : Tokens.Mobile.Colors.text)
                                .fixedSize(horizontal: false, vertical: true)
                                .gridColumnAlignment(alignments[column])
                        }
                    }
                    if index < rows.count - 1 { Divider().overlay(Tokens.Colors.border) }
                }
            }
            .font(.golem(Tokens.Mobile.FontSize.small))
        case .rule:
            Divider().overlay(Tokens.Colors.border)
        }
    }

    enum Block {
        case paragraph(AttributedString)
        case heading(AttributedString, level: Int)
        case list([Item])
        case quote(AttributedString)
        case code(String)
        /// The first row is the header.
        case table([[AttributedString]], alignments: [HorizontalAlignment])
        case rule
    }

    struct Item {
        /// "•", or "1." in an ordered list; empty for a later paragraph of the same item.
        let marker: String
        let text: AttributedString
        /// 1 for an item of a top-level list.
        let depth: Int
    }

    /// A stretch of text and the blocks that hold it, innermost first.
    private typealias Run = (intent: [PresentationIntent.IntentType], text: AttributedString)

    /// The blocks of the Markdown, as Foundation parses it (CommonMark with GitHub's tables).
    static func blocks(_ text: String, size: CGFloat, working: Set<String> = []) -> [Block] {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
        guard let parsed = try? AttributedString(markdown: text, options: options) else {
            return [.paragraph(AttributedString(text))]
        }
        let runs = Array(parsed.runs)
        let pieces: [Run] = runs.enumerated().map { index, run in
            let next = index + 1 < runs.count ? runs[index + 1].link : nil
            return (run.presentationIntent?.components ?? [], inline(parsed[run.range], next: next, size, working))
        }
        var blocks: [Block] = []
        var markedItems: Set<Int> = []
        // A table is one block; anything else is the innermost block of its text.
        for group in split(pieces, by: { ($0.intent.first(where: \.isTable) ?? $0.intent.first)?.identity }) {
            let block = block(group, markedItems: &markedItems)
            if case .list(let items) = block, case .list(let before) = blocks.last {
                blocks[blocks.count - 1] = .list(before + items)
            } else {
                blocks.append(block)
            }
        }
        return blocks
    }

    /// The text of one run, with code in a monospaced font, and links in the accent. A thread link is followed by
    /// "working" while its agent works.
    private static func inline(
        _ run: AttributedSubstring, next: URL?, _ size: CGFloat, _ working: Set<String>
    ) -> AttributedString {
        var piece = AttributedString(run)
        piece.presentationIntent = nil
        // Inter has no monospaced form, so Text does not show code as code by itself.
        if piece.inlinePresentationIntent?.contains(.code) == true {
            piece.font = .system(size: size * 0.9, design: .monospaced)
            piece.backgroundColor = Tokens.Colors.fillSubtle
        }
        guard let link = piece.link else { return piece }
        piece.foregroundColor = Tokens.Colors.accent
        let id = String(link.absoluteString.dropFirst("thread:".count))
        // A link with bold or code in it is several runs; the note follows the last.
        if link.scheme == "thread", working.contains(id), next != link {
            var note = AttributedString(" · working")
            note.foregroundColor = Tokens.Colors.textTertiary
            piece += note
        }
        return piece
    }

    /// The block of a group of runs; a list item is a list of one item.
    private static func block(_ group: [Run], markedItems: inout Set<Int>) -> Block {
        let intent = group[0].intent
        let text = group.reduce(AttributedString()) { $0 + $1.text }
        if let table = intent.first(where: \.isTable), case .table(let columns) = table.kind {
            return .table(rows(group, columns: columns.count), alignments: columns.map(\.alignment.horizontal))
        }
        switch intent.first?.kind {
        case .header(let level): return .heading(text, level: level)
        case .codeBlock: return .code(String(text.characters).trimmingCharacters(in: .newlines))
        case .thematicBreak: return .rule
        default: break
        }
        if let index = intent.firstIndex(where: \.isListItem), case .listItem(let ordinal) = intent[index].kind {
            let ordered = intent.dropFirst(index + 1).first?.kind == .orderedList
            let marker = markedItems.insert(intent[index].identity).inserted ? (ordered ? "\(ordinal)." : "•") : ""
            return .list([Item(marker: marker, text: text, depth: intent.count(where: \.isList))])
        }
        return intent.contains { $0.kind == .blockQuote } ? .quote(text) : .paragraph(text)
    }

    /// The rows of a table, each with one cell for each column; a cell with no text has no run.
    private static func rows(_ runs: [Run], columns: Int) -> [[AttributedString]] {
        split(runs, by: { $0.intent.dropFirst().first?.identity }).map { row in
            var cells = Array(repeating: AttributedString(), count: columns)
            for run in row {
                if case .tableCell(let column) = run.intent.first?.kind, column < columns { cells[column] += run.text }
            }
            return cells
        }
    }

    /// The runs in groups of neighbors with the same key.
    private static func split(_ runs: [Run], by key: (Run) -> Int?) -> [[Run]] {
        var groups: [[Run]] = []
        for run in runs {
            if let last = groups.last?.last, key(last) == key(run) {
                groups[groups.count - 1].append(run)
            } else {
                groups.append([run])
            }
        }
        return groups
    }
}

private extension PresentationIntent.IntentType {
    var isTable: Bool { if case .table = kind { true } else { false } }
    var isListItem: Bool { if case .listItem = kind { true } else { false } }
    var isList: Bool { kind == .orderedList || kind == .unorderedList }
}

private extension PresentationIntent.TableColumn.Alignment {
    var horizontal: HorizontalAlignment {
        switch self {
        case .center: .center
        case .right: .trailing
        default: .leading
        }
    }
}
