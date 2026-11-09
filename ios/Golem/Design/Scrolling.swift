import SwiftUI

extension View {
    /// Scrolls a list back to its end when it rests past it. Rows that get shorter or go away at the end, such as a
    /// work log that folds or a chat that is settled, can leave it there, which shows only empty space.
    func returnsToEnd(
        position: Binding<ScrollPosition>? = nil, onPhase: ((ScrollPhase) -> Void)? = nil
    ) -> some View {
        modifier(ReturnsToEnd(outside: position, onPhase: onPhase))
    }
}

private struct ReturnsToEnd: ViewModifier {
    let outside: Binding<ScrollPosition>?
    let onPhase: ((ScrollPhase) -> Void)?
    /// Unset, so the list starts where its default anchor puts it.
    @State private var own = ScrollPosition()
    private var position: Binding<ScrollPosition> { outside ?? $own }
    @State private var phase = ScrollPhase.idle
    @State private var pastEnd = false

    func body(content: Content) -> some View {
        content
            .scrollPosition(position)
            .onScrollPhaseChange { _, next in
                phase = next
                onPhase?(next)
                returnToEnd()
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                let end = max(
                    geometry.contentSize.height + geometry.contentInsets.bottom - geometry.containerSize.height,
                    -geometry.contentInsets.top
                )
                return geometry.contentOffset.y > end + 1
            } action: { _, past in
                pastEnd = past
                returnToEnd()
            }
    }

    private func returnToEnd() {
        if pastEnd, phase == .idle { position.wrappedValue.scrollTo(edge: .bottom) }
    }
}
