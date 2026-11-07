import SwiftUI

/// Following and Upcoming on one tab of the iPhone: what Golem follows from the accounts it reads, and what it runs
/// and what waits for the person. Pills switch between them, as Linear's do; Following comes first.
struct AgendaView: View {
    enum Page: String, CaseIterable { case following = "Following", upcoming = "Upcoming" }

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
