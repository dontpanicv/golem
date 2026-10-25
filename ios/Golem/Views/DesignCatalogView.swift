import SwiftUI

/// Every token and component on one screen, matching the web page at `/design`.
struct DesignCatalogView: View {
    private let colors: [(String, Color)] = [
        ("canvas", Tokens.Colors.canvas), ("surface", Tokens.Colors.surface), ("surfaceRaised", Tokens.Colors.surfaceRaised),
        ("fillHover", Tokens.Colors.fillHover), ("fillActive", Tokens.Colors.fillActive), ("border", Tokens.Colors.border),
        ("text", Tokens.Colors.text), ("textSecondary", Tokens.Colors.textSecondary), ("textTertiary", Tokens.Colors.textTertiary),
        ("textQuaternary", Tokens.Colors.textQuaternary), ("accent", Tokens.Colors.accent), ("success", Tokens.Colors.success),
        ("warning", Tokens.Colors.warning), ("danger", Tokens.Colors.danger),
    ]
    private let messages = [
        Message(id: "1", authorId: "anna", author: "Anna", agent: false, text: "Can you find a free Saturday for the cabin trip?", time: 1_792_928_460_000, failed: false, streaming: false),
        Message(id: "2", authorId: nil, author: "Golem", agent: true, text: "Saturday 8 November is free for everyone. I drafted a calendar event and a packing list.", time: 1_792_928_520_000, failed: false, streaming: false),
        Message(id: "3", authorId: nil, author: "Golem", agent: true, text: "Calendar access expired. Reconnect Google to continue.", time: 1_792_928_580_000, failed: true, streaming: false),
    ]
    private let sizes: [(String, CGFloat)] = [
        ("xs", Tokens.FontSize.xs), ("sm", Tokens.FontSize.sm), ("md", Tokens.FontSize.md),
        ("lg", Tokens.FontSize.lg), ("xl", Tokens.FontSize.xl), ("xxl", Tokens.FontSize.xxl),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Space.xxxl) {
                section("Color") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: Tokens.Space.lg)], spacing: Tokens.Space.lg) {
                        ForEach(colors, id: \.0) { name, color in
                            VStack(alignment: .leading, spacing: Tokens.Space.xs) {
                                RoundedRectangle(cornerRadius: Tokens.Radius.md)
                                    .fill(color)
                                    .frame(height: 40)
                                    .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.md).strokeBorder(Tokens.Colors.border, lineWidth: 0.5))
                                Text(name).font(.golem(Tokens.FontSize.sm)).foregroundStyle(Tokens.Colors.textTertiary)
                            }
                        }
                    }
                }
                section("Type") {
                    ForEach(sizes, id: \.0) { name, size in
                        Text("\(name) · Golem keeps the family organized")
                            .font(.golem(size, Tokens.FontWeight.medium))
                            .foregroundStyle(Tokens.Colors.text)
                    }
                }
                section("Buttons") {
                    HStack(spacing: Tokens.Space.lg) {
                        Button("Primary") {}.buttonStyle(.primary)
                        Button("Secondary") {}.buttonStyle(.secondary)
                        Button("Ghost") {}.buttonStyle(.ghost)
                        Button("Send", systemImage: "arrow.up") {}.labelStyle(.iconOnly).buttonStyle(.send)
                    }
                    Button("With icon", systemImage: "plus") {}.buttonStyle(.secondary)
                }
                section("Badges") {
                    HStack {
                        Badge(label: "Running", tone: .accent)
                        Badge(label: "Done", tone: .success)
                        Badge(label: "Waiting", tone: .warning)
                        Badge(label: "Failed", tone: .danger)
                    }
                }
                section("Navigation") {
                    VStack(spacing: 1) {
                        NavRow(title: "Inbox", systemImage: "tray", count: 3)
                        NavRow(title: "family", systemImage: "number")
                        NavRow(title: "Weekend plans", systemImage: "square.and.pencil", selected: true).padding(.leading, Tokens.Space.xl)
                    }
                    .padding(Tokens.Space.md)
                    .background(Tokens.Colors.canvas, in: .rect(cornerRadius: Tokens.Radius.lg))
                }
                section("Conversation") {
                    ForEach(messages) { MessageRow(message: $0) }
                    Composer(placeholder: "Message family", draft: .constant(""), send: {})
                }
                section("Empty state") {
                    EmptyState(title: "No artifacts yet", systemImage: "shippingbox").raisedCard()
                }
            }
            .padding(Tokens.Space.xxl)
        }
        .background(Tokens.Colors.surface)
        .navigationTitle("Design system")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.lg) {
            Text(title)
                .font(.golem(Tokens.FontSize.xl, Tokens.FontWeight.semibold))
                .foregroundStyle(Tokens.Colors.text)
            content()
        }
    }
}

#Preview("Design system") {
    NavigationStack { DesignCatalogView() }
}
