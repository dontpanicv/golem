import SwiftUI

// MARK: - Settings card

/// A settings card with an optional section title above. Rows are separated by hairlines.
struct SettingsCard<Content: View>: View {
    var title: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.lg) {
            if let title {
                Text(title)
                    .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.medium))
                    .foregroundStyle(Tokens.Colors.text)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(spacing: 0) {
                Group(subviews: content) { rows in
                    ForEach(rows) { row in
                        if row.id != rows.first?.id {
                            Rectangle().fill(Tokens.Colors.borderSubtle).frame(height: 0.5)
                        }
                        row
                    }
                }
            }
            .raisedCard()
        }
    }
}

/// A settings row: label and description on the left, the control on the right.
struct SettingsRow<Leading: View, Control: View>: View {
    let label: String
    var description: String?
    var descriptionColor = Tokens.Colors.textTertiary
    @ViewBuilder let leading: Leading
    @ViewBuilder let control: Control

    var body: some View {
        HStack(spacing: Tokens.Space.lg) {
            leading
            VStack(alignment: .leading, spacing: Tokens.Space.xxs) {
                Text(label)
                    .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
                    .foregroundStyle(Tokens.Colors.text)
                if let description {
                    Text(description)
                        .font(.golem(Tokens.FontSize.sm, Tokens.FontWeight.book))
                        .foregroundStyle(descriptionColor)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control
        }
        .padding(Tokens.Space.xl)
        .frame(minHeight: Tokens.Size.settingsRow)
    }
}

extension SettingsRow where Leading == EmptyView {
    init(
        _ label: String, description: String? = nil, descriptionColor: Color = Tokens.Colors.textTertiary,
        @ViewBuilder control: () -> Control
    ) {
        self.init(
            label: label, description: description, descriptionColor: descriptionColor,
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
            HStack {
                Text(title)
                    .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.semibold))
                    .foregroundStyle(Tokens.Colors.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Close", systemImage: "xmark") { dismiss() }
                    .buttonStyle(.golem(.ghost, .icon))
            }
            .padding(.leading, Tokens.Space.xl)
            .padding(.trailing, Tokens.Space.md)
            .frame(height: 52)
            VStack(alignment: .leading, spacing: Tokens.Space.lg) { content }
                .padding(Tokens.Space.xl)
            HStack(spacing: Tokens.Space.md) { actions }
                .padding([.horizontal, .bottom], Tokens.Space.xl)
        }
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        .frame(maxHeight: .infinity, alignment: .top)
        .environment(\.onRaisedSurface, true)
        .toasts()
        // The medium detent left half the sheet empty, so the sheet fits its content.
        .presentationDetents(height.map { [.height($0)] } ?? [.medium])
        .presentationCornerRadius(Tokens.Radius.xl)
        .presentationBackground(Tokens.Colors.surfaceRaised)
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
    /// Shows the session's toast at the top: it slides 8 pt and fades in 140 ms, and goes after 5 s or a tap.
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
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -8)))
                    .task(id: toast.id) {
                        AccessibilityNotification.Announcement(toast.message).post()
                        try? await Task.sleep(for: .seconds(5))
                        if session.toast?.id == toast.id { session.toast = nil }
                    }
            }
        }
        .padding(.horizontal, Tokens.Space.xl)
        .padding(.top, Tokens.Space.lg)
        .animation(Tokens.Easing.out(Tokens.Duration.menu), value: session.toast)
    }
}

struct ToastView: View {
    let toast: Toast

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            if toast.tone != .neutral {
                Circle()
                    .fill(toast.tone == .success ? Tokens.Colors.success : Tokens.Colors.danger)
                    .frame(width: 6, height: 6)
            }
            Text(toast.message)
                .font(.golem(Tokens.FontSize.md))
                .foregroundStyle(Tokens.Colors.textSecondary)
        }
        .padding(.vertical, Tokens.Space.md)
        .padding(.horizontal, Tokens.Space.lg)
        .floatingCard()
        .frame(maxWidth: 440)
        .accessibilityElement(children: .combine)
    }
}
