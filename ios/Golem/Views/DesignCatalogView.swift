import SwiftUI

/// Every token and component on one screen, matching the web page at `/design`.
struct DesignCatalogView: View {
    @Environment(Session.self) private var session
    @State private var text = ""
    @State private var model = "gpt-5.5"
    @State private var switchOn = true
    @State private var switchOff = false
    @State private var checked = true
    @State private var unchecked = false
    @State private var dialog = false
    private let colors: [(String, Color)] = [
        ("canvas", Tokens.Colors.canvas), ("surface", Tokens.Colors.surface), ("surfaceRaised", Tokens.Colors.surfaceRaised),
        ("fillHover", Tokens.Colors.fillHover), ("fillActive", Tokens.Colors.fillActive), ("surfaceHover", Tokens.Colors.surfaceHover),
        ("switchTrack", Tokens.Colors.switchTrack), ("border", Tokens.Colors.border), ("borderStrong", Tokens.Colors.borderStrong),
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
                        Button("Danger") {}.buttonStyle(.danger)
                    }
                    HStack(spacing: Tokens.Space.lg) {
                        Button("Small", systemImage: "plus") {}.buttonStyle(.golem(.secondary, .small))
                        Button("Small") {}.buttonStyle(.golem(.ghost, .small))
                        Button("More", systemImage: "ellipsis") {}.buttonStyle(.golem(.ghost, .icon))
                        Button("Settings", systemImage: "gearshape") {}.buttonStyle(.golem(.secondary, .icon))
                        Button("Send", systemImage: "arrow.up") {}.buttonStyle(.send)
                    }
                    HStack(spacing: Tokens.Space.lg) {
                        Button("Disabled") {}.buttonStyle(.primary).disabled(true)
                        Button("Disabled") {}.buttonStyle(.secondary).disabled(true)
                    }
                    Button("Large") {}.buttonStyle(.golem(.primary, .large))
                }
                section("Text field") {
                    GolemTextField("Label", placeholder: "Placeholder", text: $text)
                    GolemTextField("Password", text: .constant("secret"), secure: true)
                    GolemTextField("Large", placeholder: "Email", text: .constant(""), large: true)
                }
                section("Select and menu") {
                    HStack(spacing: Tokens.Space.lg) {
                        GolemSelect(selection: $model, options: ["gpt-5.5", "gpt-5.5-mini", "o5"])
                        GolemMenu {
                            MenuSectionLabel("Thread")
                            MenuItem("Rename", systemImage: "pencil") {}
                            MenuItem("Copy link", systemImage: "link") {}
                            MenuSeparator()
                            MenuItem("Delete", systemImage: "trash", role: .destructive) {}
                        } label: {
                            Label("Actions", systemImage: "ellipsis")
                        }
                        .buttonStyle(.golem(.secondary, .icon))
                    }
                    // The open menu, drawn in place.
                    VStack(alignment: .leading, spacing: 0) {
                        MenuSectionLabel("Workspaces")
                        MenuItem("Family", checked: true) {}
                        MenuItem("Work") {}
                        MenuSeparator()
                        MenuItem("New workspace", systemImage: "plus") {}
                    }
                    .padding(.vertical, Tokens.Space.xs)
                    .frame(width: 220)
                    .floatingCard()
                }
                section("Switch and checkbox") {
                    HStack(spacing: Tokens.Space.xxl) {
                        Toggle("On", isOn: $switchOn).toggleStyle(.golemSwitch)
                        Toggle("Off", isOn: $switchOff).toggleStyle(.golemSwitch)
                        Toggle("Disabled", isOn: .constant(true)).toggleStyle(.golemSwitch).disabled(true)
                    }
                    Toggle("Share with all agents in this workspace", isOn: $checked).toggleStyle(.checkbox)
                    Toggle("Unchecked", isOn: $unchecked).toggleStyle(.checkbox)
                }
                section("Toast and dialog") {
                    HStack(spacing: Tokens.Space.lg) {
                        Button("Neutral") { session.show("Thread archived") }.buttonStyle(.secondary)
                        Button("Success") { session.show("Credential added", .success) }.buttonStyle(.secondary)
                        Button("Error") { session.show("Calendar access expired", .error) }.buttonStyle(.secondary)
                    }
                    Button("Open dialog") { dialog = true }.buttonStyle(.secondary)
                    ToastView(toast: Toast(message: "Saved", tone: .success))
                }
                section("Settings card") {
                    SettingsCard(title: "Integration") {
                        SettingsRow("Enabled", description: "Agents in this workspace can use Google") {
                            Toggle(isOn: $switchOn) {}.toggleStyle(.golemSwitch).accessibilityLabel("Enabled")
                        }
                        SettingsRow("Model") {
                            GolemSelect(selection: $model, options: ["gpt-5.5", "gpt-5.5-mini", "o5"])
                        }
                        SettingsRow("Anna", description: "anna@example.com") {
                            Button("Sign out") {}.buttonStyle(.secondary)
                        }
                    }
                }
                section("Badges and keycap") {
                    HStack {
                        Badge(label: "Running", tone: .accent)
                        Badge(label: "Done", tone: .success)
                        Badge(label: "Waiting", tone: .warning)
                        Badge(label: "Failed", tone: .danger)
                    }
                    HStack(spacing: Tokens.Space.xs) {
                        Keycap(key: "⌘")
                        Keycap(key: "K")
                        Keycap(key: "Esc")
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
        .sheet(isPresented: $dialog) {
            Dialog(title: "New channel") {
                GolemTextField("Name", placeholder: "weekend-plans", text: $text)
            } actions: {
                Button("Cancel") { dialog = false }.buttonStyle(.golem(.secondary, .large))
                Button("Create") { dialog = false }.buttonStyle(.golem(.primary, .large))
            }
        }
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
    NavigationStack { DesignCatalogView() }.environment(Session())
}
