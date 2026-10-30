import SwiftUI
import Testing

@testable import Golem

/// An agent's Markdown shows as blocks, as the web shows it, with no `#`, `|`, or `-` left in the text.
@Suite("Markdown")
struct MarkdownTextTests {
    private let text = """
        ## Plan
        Read [the notes](thread:t1) first.

        - one
          - nested
        1. first

        | Name | Count |
        |------|------:|
        | a | |

        > quoted

        ---

        ```
        let x = 1
        ```
        """

    @Test func blocksKeepTheirKinds() {
        let blocks = MarkdownText.blocks(text, size: 16, working: ["t1"])
        #expect(blocks.count == 7)
        guard case .heading(let heading, 2) = blocks[0] else { Issue.record("no heading"); return }
        #expect(String(heading.characters) == "Plan")
        guard case .paragraph(let paragraph) = blocks[1] else { Issue.record("no paragraph"); return }
        #expect(String(paragraph.characters) == "Read the notes · working first.")
        guard case .list(let bullets) = blocks[2] else { Issue.record("no list"); return }
        #expect(bullets.map(\.marker) == ["•", "•", "1."])
        #expect(bullets.map(\.depth) == [1, 2, 1])
        guard case .table(let rows, let alignments) = blocks[3] else { Issue.record("no table"); return }
        #expect(rows.map { $0.map { String($0.characters) } } == [["Name", "Count"], ["a", ""]])
        #expect(alignments == [.leading, .trailing])
        guard case .quote = blocks[4], case .rule = blocks[5], case .code(let code) = blocks[6] else {
            Issue.record("no quote, rule, or code"); return
        }
        #expect(code == "let x = 1")
    }
}
