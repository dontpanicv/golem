import SwiftUI

// MARK: - Text field

/// A text or secure field with an optional label above. Keyboard, content type, and submit modifiers
/// applied to it reach the inner field through the environment.
struct GolemTextField: View {
    let label: String?
    let placeholder: String
    @Binding var text: String
    var secure = false
    var large = false
    /// Focuses the field when it appears, as the alerts these fields replace did.
    var autofocus = false
    @FocusState private var focused: Bool

    init(_ label: String?, placeholder: String? = nil, text: Binding<String>, secure: Bool = false, large: Bool = false, autofocus: Bool = false) {
        self.label = label
        self.placeholder = placeholder ?? label ?? ""
        _text = text
        self.secure = secure
        self.large = large
        self.autofocus = autofocus
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.xs) {
            if let label {
                Text(label)
                    .font(.golem(Tokens.FontSize.sm, Tokens.FontWeight.medium))
                    .foregroundStyle(Tokens.Colors.textTertiary)
                    .accessibilityHidden(true)
            }
            field
                .focused($focused)
                .font(.golem(Tokens.FontSize.md))
                .foregroundStyle(Tokens.Colors.text)
                .padding(.horizontal, Tokens.Space.lg)
                .frame(height: large ? Tokens.Size.controlLarge : Tokens.Size.control)
                .background(Tokens.Colors.surfaceRaised, in: .rect(cornerRadius: Tokens.Radius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: Tokens.Radius.md)
                        .strokeBorder(focused ? Tokens.Colors.accent : Tokens.Colors.borderStrong, lineWidth: focused ? 1 : 0.5)
                )
                .contentShape(.rect)
                .onTapGesture { focused = true }
                .animation(Tokens.Easing.out(Tokens.Duration.fast), value: focused)
        }
        .onAppear { if autofocus { focused = true } }
    }

    @ViewBuilder private var field: some View {
        let prompt = Text(placeholder).foregroundStyle(Tokens.Colors.textQuaternary)
        if secure {
            SecureField(label ?? placeholder, text: $text, prompt: prompt)
        } else {
            TextField(label ?? placeholder, text: $text, prompt: prompt)
        }
    }
}

// MARK: - Switch

/// A 30 × 20 switch. Use `Toggle(isOn:) {}` with an accessibility label where the row already shows the label.
/// The knob's front edge leads and its back edge follows 50 ms later, so it stretches as it moves.
struct SwitchToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: Tokens.Space.md) {
            configuration.label
            Button { configuration.isOn.toggle() } label: { EmptyView() }
                .buttonStyle(SwitchButtonStyle(isOn: configuration.isOn))
        }
        .accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label }.toggleStyle(.switch) }
    }
}

private struct SwitchButtonStyle: ButtonStyle {
    let isOn: Bool

    func makeBody(configuration: Configuration) -> some View {
        SwitchTrack(isOn: isOn, pressed: configuration.isPressed)
    }
}

private struct SwitchTrack: View {
    let isOn: Bool
    let pressed: Bool
    @State private var leading: CGFloat
    @State private var trailing: CGFloat
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let inset: CGFloat = 3
    private static let travel = Tokens.Size.switchWidth - Tokens.Size.switchKnob - 2 * inset
    private static let pressWidening: CGFloat = 4

    init(isOn: Bool, pressed: Bool) {
        self.isOn = isOn
        self.pressed = pressed
        let edges = Self.edges(isOn)
        _leading = State(initialValue: edges.leading)
        _trailing = State(initialValue: edges.trailing)
    }

    var body: some View {
        let widen = pressed && !reduceMotion ? Self.pressWidening : 0
        Capsule()
            .fill(isOn ? Tokens.Colors.accent : Tokens.Colors.switchTrack)
            .animation(Tokens.Easing.out(Tokens.Duration.fast), value: isOn)
            .overlay {
                KnobShape(leading: leading - (isOn ? widen : 0), trailing: trailing + (isOn ? 0 : widen), size: Tokens.Size.switchKnob)
                    .fill(Tokens.Colors.onAccent)
                    .shadow(color: .black.opacity(0.12), radius: 1, y: 0.5)
                    .animation(Tokens.Easing.out(Tokens.Duration.knob), value: pressed)
            }
            .frame(width: Tokens.Size.switchWidth, height: Tokens.Size.switchHeight)
            .opacity(isEnabled ? 1 : 0.5)
            .contentShape(.interaction, Rectangle().inset(by: -(Tokens.Size.listRow - Tokens.Size.switchHeight) / 2))
            .onChange(of: isOn) { _, on in move(on) }
    }

    private func move(_ on: Bool) {
        let target = Self.edges(on)
        guard !reduceMotion else {
            leading = target.leading
            trailing = target.trailing
            return
        }
        let front = Tokens.Easing.out(Tokens.Duration.knob)
        let back = front.delay(0.05)
        // Turning on moves right, so the trailing edge leads; turning off, the leading edge leads.
        withAnimation(on ? front : back) { trailing = target.trailing }
        withAnimation(on ? back : front) { leading = target.leading }
    }

    private static func edges(_ on: Bool) -> (leading: CGFloat, trailing: CGFloat) {
        let leading = inset + (on ? travel : 0)
        return (leading, leading + Tokens.Size.switchKnob)
    }
}

/// The knob as two animated edges, so each edge can follow its own timing.
private nonisolated struct KnobShape: Shape {
    var leading: CGFloat
    var trailing: CGFloat
    let size: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(leading, trailing) }
        set { (leading, trailing) = (newValue.first, newValue.second) }
    }

    func path(in rect: CGRect) -> Path {
        let frame = CGRect(x: leading, y: (rect.height - size) / 2, width: max(size, trailing - leading), height: size)
        return Capsule().path(in: frame)
    }
}

extension ToggleStyle where Self == SwitchToggleStyle {
    static var golemSwitch: SwitchToggleStyle { SwitchToggleStyle() }
}

// MARK: - Checkbox

/// A 14 pt checkbox with the label to the right; the whole row toggles.
struct CheckboxToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.md) {
                CheckboxBox(isOn: configuration.isOn)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                configuration.label
                    .font(.golem(Tokens.FontSize.md))
                    .foregroundStyle(Tokens.Colors.textSecondary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .frame(minHeight: Tokens.Size.listRow)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityRepresentation { Toggle(isOn: configuration.$isOn) { configuration.label }.toggleStyle(.switch) }
    }
}

private struct CheckboxBox: View {
    let isOn: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.Radius.xs)
        shape
            .fill(isOn ? Tokens.Colors.accent : Tokens.Colors.surfaceRaised)
            .overlay(shape.strokeBorder(isOn ? Tokens.Colors.accent : Tokens.Colors.borderStrong, lineWidth: 1))
            .overlay {
                CheckMark()
                    .trim(from: 0, to: isOn || reduceMotion ? 1 : 0)
                    .stroke(Tokens.Colors.onAccent, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                    .frame(width: 10, height: 10)
                    .opacity(isOn ? 1 : 0)
            }
            .frame(width: Tokens.Size.checkbox, height: Tokens.Size.checkbox)
            .animation(Tokens.Easing.out(Tokens.Duration.fast), value: isOn)
    }
}

private nonisolated struct CheckMark: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.width * 0.15, y: rect.height * 0.52))
            path.addLine(to: CGPoint(x: rect.width * 0.4, y: rect.height * 0.76))
            path.addLine(to: CGPoint(x: rect.width * 0.86, y: rect.height * 0.26))
        }
    }
}

extension ToggleStyle where Self == CheckboxToggleStyle {
    static var checkbox: CheckboxToggleStyle { CheckboxToggleStyle() }
}
