import SwiftUI

/// The open workspace's notifications, newest first, as Linear's Inbox: a tap reads one and opens its thread or
/// channel.
struct InboxView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(session.inbox?.notifications ?? []) { row($0) }
            }
            .padding(.bottom, Tokens.Space.xxxl)
        }
        .overlay {
            if session.inbox?.notifications.isEmpty ?? false {
                EmptyState(title: "No notifications", systemImage: "bell")
            }
        }
        .task { await session.run { try await session.loadInbox() } }
        .refreshable { await session.run { try await session.loadInbox() } }
        .phoneTabBar()
        .mobileBackground()
        .screenTitle("Inbox")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Mark all read", systemImage: "checkmark") {
                    Task { await session.run { try await session.readNotifications(nil) } }
                }
                .disabled((session.inbox?.unread ?? 0) == 0)
            }
        }
    }

    private func row(_ notification: InboxNotification) -> some View {
        Button {
            if notification.readAt == nil {
                Task { await session.run { try await session.readNotifications(notification.id) } }
            }
            open(notification.destination)
        } label: {
            ListRow(
                title: notification.title, systemImage: notification.threadId == nil ? "number" : "bubble.left",
                subtitle: notification.text
            ) {
                Text(Date(milliseconds: notification.createdAt).formatted(.dateTime.day().month(.abbreviated)))
                    .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.book))
                    .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                Circle()
                    .fill(notification.readAt == nil ? Tokens.Colors.accent : .clear)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel(notification.readAt == nil ? "Unread" : "")
            }
        }
        .buttonStyle(.plain)
    }
}
