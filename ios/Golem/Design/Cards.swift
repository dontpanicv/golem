import SwiftUI

// MARK: - Settings list

/// The settings of a screen as Linear's iOS settings show them: flat groups on the page, a full-width hairline
/// between groups.
struct SettingsList<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Group(subviews: content) { groups in
                    ForEach(groups) { group in
                        if group.id != groups.first?.id { ListSeparator() }
                        group
                    }
                }
            }
            .frame(maxWidth: 640)
            .padding(.bottom, Tokens.Space.xxxl)
            .frame(maxWidth: .infinity)
        }
        .mobileBackground()
    }
}

/// A group of settings rows with an optional small title above, as Linear's list sections.
struct SettingsCard<Content: View>: View {
    var title: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title { ListSectionHeader(title: title) }
            content
        }
    }
}

/// A settings row: label and description on the left, the control on the right, 20 pt in from the edges.
struct SettingsRow<Leading: View, Control: View>: View {
    let label: String
    var description: String?
    var descriptionColor = Tokens.Mobile.Colors.textTertiary
    var labelColor = Tokens.Mobile.Colors.text
    @ViewBuilder let leading: Leading
    @ViewBuilder let control: Control

    var body: some View {
        HStack(spacing: Tokens.Space.lg) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.book))
                    .foregroundStyle(labelColor)
                if let description {
                    Text(description)
                        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
                        .foregroundStyle(descriptionColor)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control
        }
        .padding(.horizontal, Tokens.Mobile.Size.margin)
        .padding(.vertical, Tokens.Space.sm)
        .frame(minHeight: Tokens.Mobile.Size.settingsRow)
    }
}

extension SettingsRow where Leading == EmptyView {
    init(
        _ label: String, description: String? = nil, descriptionColor: Color = Tokens.Mobile.Colors.textTertiary,
        labelColor: Color = Tokens.Mobile.Colors.text, @ViewBuilder control: () -> Control
    ) {
        self.init(
            label: label, description: description, descriptionColor: descriptionColor, labelColor: labelColor,
            leading: { EmptyView() }, control: control
        )
    }
}

extension SettingsRow where Leading == EmptyView, Control == EmptyView {
    init(_ label: String, description: String? = nil) {
        self.init(label, description: description) { EmptyView() }
    }
}

// MARK: - Dialog

/// A dialog in a sheet sized to its content: a title with a close button, stacked fields, and right-aligned
/// actions, secondary then primary. Present it with `.sheet`.
struct Dialog<Content: View, Actions: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @ViewBuilder let actions: Actions
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var height: CGFloat?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // As Linear's sheets: a round glass close button and the title in the middle.
            ZStack {
                Text(title)
                    .font(.golem(Tokens.Mobile.FontSize.sheetTitle, Tokens.FontWeight.semibold))
                    .foregroundStyle(Tokens.Mobile.Colors.text)
                    .lineLimit(1)
                    .padding(.horizontal, 56)
                    .accessibilityAddTraits(.isHeader)
                HStack {
                    GlassCircleButton(label: "Close", systemImage: "xmark", size: 40) { dismiss() }
                    Spacer()
                }
            }
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.top, Tokens.Mobile.Size.margin)
            .padding(.bottom, Tokens.Space.sm)
            VStack(alignment: .leading, spacing: Tokens.Space.lg) { content }
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.vertical, Tokens.Space.lg)
            HStack(spacing: Tokens.Space.md) { actions }
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.top, Tokens.Space.xl)
                .padding(.bottom, Tokens.Space.lg)
        }
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        .frame(maxHeight: .infinity, alignment: .top)
        .toasts()
        // The medium detent left half the sheet empty, so the sheet fits its content.
        .presentationDetents(height.map { [.height($0)] } ?? [.medium])
        .presentationBackground(Tokens.Mobile.Colors.background)
        // The root toast hides while a dialog shows its own above the dimmed screen.
        .onAppear { session.dialogs += 1 }
        .onDisappear { session.dialogs -= 1 }
    }
}

// MARK: - Toast

struct Toast: Identifiable, Equatable {
    enum Tone { case neutral, success, error }

    let id = UUID()
    let message: String
    var tone = Tone.neutral
}

extension View {
    /// Shows the session's toast at the top: it slides in from above its own height and fades in 400 ms, and goes
    /// after 4 s or a tap.
    func toasts(hidden: Bool = false) -> some View {
        overlay(alignment: .top) { ToastHost().opacity(hidden ? 0 : 1) }
    }
}

private struct ToastHost: View {
    @Environment(Session.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if let toast = session.toast {
                ToastView(toast: toast)
                    .onTapGesture { session.toast = nil }
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                    .task(id: toast.id) {
                        AccessibilityNotification.Announcement(toast.message).post()
                        try? await Task.sleep(for: .seconds(4))
                        if session.toast?.id == toast.id { session.toast = nil }
                    }
            }
        }
        .padding(.horizontal, Tokens.Space.xl)
        .padding(.top, Tokens.Space.lg)
        .animation(Tokens.Easing.ease(Tokens.Duration.toast), value: session.toast)
    }
}

struct ToastView: View {
    let toast: Toast

    private var symbol: String {
        switch toast.tone {
        case .neutral: "info.circle.fill"
        case .success: "checkmark.circle.fill"
        case .error: "exclamationmark.circle.fill"
        }
    }

    private var color: Color {
        switch toast.tone {
        case .neutral: Tokens.Colors.textSecondary
        case .success: Tokens.Colors.success
        case .error: Tokens.Colors.danger
        }
    }

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            Image(systemName: symbol)
                .font(.system(size: 14))
                .foregroundStyle(color)
                .frame(width: Tokens.Size.icon, height: Tokens.Size.icon)
            Text(toast.message)
                .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
                .foregroundStyle(Tokens.Colors.text)
            Spacer(minLength: 0)
        }
        .padding(Tokens.Space.lg)
        .floatingCard()
        .frame(maxWidth: Tokens.Size.toast)
        .accessibilityElement(children: .combine)
    }
}
