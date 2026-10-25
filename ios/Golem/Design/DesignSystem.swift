import SwiftUI
import UIKit

// The Golem design system for iOS. Values come from Tokens.swift, generated from design/tokens.json,
// so the app matches the web components in public/styles.css.

extension Color {
    /// A color that follows the light or dark appearance. Hex is `#rrggbb` or `#rrggbbaa`.
    init(light: String, dark: String) {
        self.init(uiColor: UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
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

    /// A raised card: composer, popover, or showcase tile.
    func raisedCard(radius: CGFloat = Tokens.Radius.lg) -> some View {
        background(Tokens.Colors.surfaceRaised, in: .rect(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Tokens.Colors.border, lineWidth: 0.5))
            .shadow(Tokens.Shadows.low)
    }
}

// MARK: - Buttons

struct GolemButtonStyle: ButtonStyle {
    enum Variant { case primary, secondary, ghost }

    var variant: Variant = .secondary
    var round = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: round ? Tokens.Radius.full : Tokens.Radius.md)
        configuration.label
            .font(.golem(Tokens.FontSize.md, Tokens.FontWeight.medium))
            .foregroundStyle(variant == .primary ? Tokens.Colors.onAccent : Tokens.Colors.textSecondary)
            .padding(.horizontal, round ? 0 : Tokens.Space.lg)
            .frame(minWidth: Tokens.Size.control, minHeight: Tokens.Size.control)
            .background(background(pressed: configuration.isPressed), in: shape)
            .overlay(shape.strokeBorder(variant == .secondary ? Tokens.Colors.borderStrong : .clear, lineWidth: 0.5))
            .contentShape(shape)
            .opacity(isEnabled ? 1 : 0.5)
            .animation(.easeOut(duration: Tokens.Duration.fast), value: configuration.isPressed)
    }

    private func background(pressed: Bool) -> Color {
        switch variant {
        case .primary: pressed ? Tokens.Colors.accentHover : Tokens.Colors.accent
        case .secondary: pressed ? Tokens.Colors.fillHover : Tokens.Colors.surfaceRaised
        case .ghost: pressed ? Tokens.Colors.fillHover : .clear
        }
    }
}

extension ButtonStyle where Self == GolemButtonStyle {
    static var primary: GolemButtonStyle { GolemButtonStyle(variant: .primary) }
    static var secondary: GolemButtonStyle { GolemButtonStyle(variant: .secondary) }
    static var ghost: GolemButtonStyle { GolemButtonStyle(variant: .ghost) }
    static var send: GolemButtonStyle { GolemButtonStyle(variant: .primary, round: true) }
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
