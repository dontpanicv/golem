import SwiftUI

/// Upcoming and Following on one tab of the iPhone: what Golem runs and what waits for the person, and what it follows
/// from the accounts it reads. Pills switch between them, as Linear's do.
struct AgendaView: View {
    enum Page: String, CaseIterable { case upcoming = "Upcoming", following = "Following" }

    @Binding var page: Page
    let open: (Destination) -> Void

    var body: some View {
        Group {
            switch page {
            case .upcoming: UpcomingView(open: open, embedded: true)
            case .following: FollowingView(open: open, embedded: true)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            PillBar(selection: $page, options: Page.allCases) { $0.rawValue }
                .padding(.vertical, Tokens.Space.md)
        }
        .screenTitle("Agenda")
    }
}
