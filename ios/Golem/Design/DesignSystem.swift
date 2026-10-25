import SwiftUI
import UIKit

// The Golem design system for iOS. Values come from Tokens.swift, generated from design/tokens.json,
// so the app matches the web components in public/styles.css.

extension Color {
    /// A color that follows the light or dark appearance. Hex is `#rrggbb` or `#rrggbbaa`.
    init(light: String, dark: String) {
        let light = UIColor(hex: light), dark = UIColor(hex: dark)
        // SwiftUI resolves colors on its render thread too, so the provider must not be main-actor isolated.
        self.init(uiColor: UIColor { @Sendable traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }
}

extension UIColor {
    convenience init(hex: String) {
        let value = UInt64(hex.dropFirst(), radix: 16) ?? 0
        let hasAlpha = hex.count == 9
        let rgb = hasAlpha ? value >> 8 : value
        self.init(
            red: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: hasAlpha ? CGFloat(value & 0xff) / 255 : 1
        )
    }
}

extension Font {
    /// Inter at a token size; scales with Dynamic Type.
    static func golem(_ size: CGFloat, _ weight: Font.Weight = Tokens.FontWeight.regular) -> Font {
        .custom("Inter Variable", size: size, relativeTo: .body).weight(weight)
    }
}

struct Shadow {
    let y: CGFloat
    let blur: CGFloat
    let opacity: Double
}

extension View {
    func shadow(_ layers: [Shadow]) -> some View {
        layers.reduce(AnyView(self)) { view, layer in
            AnyView(view.shadow(color: .black.opacity(layer.opacity), radius: layer.blur / 2, y: layer.y))
        }
    }

    /// A raised card: composer, settings card, or showcase tile.
    func raisedCard(radius: CGFloat = Tokens.Radius.lg) -> some View {
        background(Tokens.Colors.surfaceRaised, in: .rect(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Tokens.Colors.border, lineWidth: 0.5))
            .shadow(Tokens.Shadows.low)
            .environment(\.onRaisedSurface, true)
    }

    /// A floating card: menu, toast, or dialog. A 0.5 pt `borderStrong` ring and the `menu` shadow.
    func floatingCard(radius: CGFloat = Tokens.Radius.xl) -> some View {
        background(Tokens.Colors.surfaceRaised, in: .rect(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Tokens.Colors.borderStrong, lineWidth: 0.5))
            .shadow(Tokens.Shadows.menu)
            .environment(\.onRaisedSurface, true)
    }
}

extension EnvironmentValues {
    /// Set inside cards, menus, and dialogs: ghost buttons press to `surfaceHover` instead of `fillHover`.
    @Entry var onRaisedSurface = false
}

// MARK: - Small components

struct Avatar: View {
    let name: String
    var agent = false
    var size = Tokens.Size.avatar

    var body: some View {
        Text(name.prefix(1).uppercased())
            .font(.golem(size * 0.45, Tokens.FontWeight.semibold))
            .foregroundStyle(agent ? Tokens.Colors.onAccent : Tokens.Colors.textSecondary)
            .frame(width: size, height: size)
            .background(
                agent ? Tokens.Colors.accent : Tokens.Colors.fillActive,
                in: .rect(cornerRadius: agent ? Tokens.Radius.md : Tokens.Radius.full)
            )
            .accessibilityHidden(true)
    }
}

struct Badge: View {
    enum Tone { case neutral, accent, success, warning, danger }

    let label: String
    var tone = Tone.neutral

    var body: some View {
        HStack(spacing: Tokens.Space.xs) {
            Circle().frame(width: 6, height: 6)
            Text(label)
        }
        .font(.golem(Tokens.FontSize.xs, Tokens.FontWeight.medium))
        .foregroundStyle(color)
        .padding(.horizontal, Tokens.Space.sm)
        .frame(height: 20)
        .overlay(Capsule().strokeBorder(Tokens.Colors.border, lineWidth: 0.5))
    }

    private var color: Color {
        switch tone {
        case .neutral: Tokens.Colors.textTertiary
        case .accent: Tokens.Colors.accent
        case .success: Tokens.Colors.success
        case .warning: Tokens.Colors.warning
        case .danger: Tokens.Colors.danger
        }
    }
}

/// A file attached to a message, or picked in the composer; picked files have a button that takes them out.
struct FileChip: View {
    let name: String
    var remove: (() -> Void)?

    var body: some View {
        HStack(spacing: Tokens.Space.xs) {
            Image(systemName: "paperclip").foregroundStyle(Tokens.Colors.textTertiary)
            Text(name).lineLimit(1).truncationMode(.middle)
            if let remove {
                Button("Remove \(name)", systemImage: "xmark", action: remove)
                    .labelStyle(.iconOnly)
                    .foregroundStyle(Tokens.Colors.textTertiary)
                    .frame(minWidth: Tokens.Size.listRow, minHeight: Tokens.Size.listRow)
                    .padding(.horizontal, -Tokens.Space.lg)
            }
        }
        .font(.golem(Tokens.FontSize.sm))
        .foregroundStyle(Tokens.Colors.textSecondary)
        .padding(.horizontal, Tokens.Space.lg)
        .frame(maxWidth: 240, minHeight: Tokens.Size.controlSmall)
        .background(Tokens.Colors.fillSubtle, in: .rect(cornerRadius: Tokens.Radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: Tokens.Radius.md)
                .strokeBorder(Tokens.Colors.borderStrong, lineWidth: 0.5)
        )
        // Touch target: 44 pt where the web chip is 28 px.
        .frame(minHeight: Tokens.Size.listRow)
        .contentShape(.rect)
    }
}

/// A keyboard shortcut.
struct Keycap: View {
    let key: String

    var body: some View {
        Text(key)
            .font(.golem(Tokens.FontSize.xs, Tokens.FontWeight.medium))
            .foregroundStyle(Tokens.Colors.textTertiary)
            .padding(.horizontal, Tokens.Space.xs)
            .frame(minWidth: 18, minHeight: 18)
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.xs)
                    .strokeBorder(Tokens.Colors.borderStrong, lineWidth: 0.5)
            )
    }
}

/// A sidebar or list row: icon, label, optional count. Selected rows use the active fill.
struct NavRow: View {
    let title: String
    let systemImage: String
    var selected = false
    var count: Int?

    var body: some View {
        HStack(spacing: Tokens.Space.md) {
            Image(systemName: systemImage)
                .font(.system(size: Tokens.Size.icon * 0.8, weight: .medium))
                .frame(width: Tokens.Size.icon)
            Text(title).lineLimit(1)
            Spacer(minLength: 0)
            if let count {
                Text("\(count)").font(.golem(Tokens.FontSize.xs, Tokens.FontWeight.book))
            }
        }
        .font(.golem(Tokens.FontSize.lg, Tokens.FontWeight.medium))
        .foregroundStyle(selected ? Tokens.Colors.text : Tokens.Colors.textTertiary)
        .padding(.horizontal, Tokens.Space.sm)
        // Touch target: 44 pt on iOS where the web row is 28 px.
        .frame(minHeight: Tokens.Size.listRow)
        .background(selected ? Tokens.Colors.fillActive : .clear, in: .rect(cornerRadius: Tokens.Radius.md))
        .contentShape(.rect)
    }
}

struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.golem(Tokens.FontSize.sm, Tokens.FontWeight.medium))
            .foregroundStyle(Tokens.Colors.textTertiary)
            .padding(.horizontal, Tokens.Space.sm)
            .padding(.top, Tokens.Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EmptyState: View {
    let title: String
    let systemImage: String

    var body: some View {
        VStack(spacing: Tokens.Space.sm) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(Tokens.Colors.textQuaternary)
            Text(title)
                .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
                .foregroundStyle(Tokens.Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Tokens.Space.xxxl)
    }
}
