import SwiftUI

/// The open workspace's notifications, newest first, as Slack's Activity: All or Unread, each with Golem's avatar,
/// where it happened, and a dot while unread. A tap reads one and opens its chat or topic.
struct InboxView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var shown = Shown.all

    enum Shown: CaseIterable { case all, unread }

    private var notifications: [InboxNotification] {
        (session.inbox?.notifications ?? []).filter { shown == .all || $0.readAt == nil }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                PillBar(selection: $shown, options: Shown.allCases) { $0 == .all ? "All" : "Unread" } count: {
                    $0 == .unread ? session.inbox?.unread : nil
                }
                .padding(.bottom, Tokens.Space.sm)
                ForEach(notifications) { row($0) }
            }
            .padding(.bottom, Tokens.Space.xxxl)
            .animation(.snappy, value: notifications)
        }
        .returnsToEnd()
        .overlay {
            if notifications.isEmpty, session.inbox != nil {
                EmptyState(title: shown == .all ? "No notifications" : "All read")
            }
        }
        .task { await session.run { try await session.loadInbox() } }
        .refreshable { await session.run { try await session.loadInbox() } }
        .phoneTabBar()
        .mobileBackground()
        .screenTitle("Activity")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Mark all read", pixel: .check) {
                    Task { await session.run { try await session.readNotifications(nil) } }
                }
                .buttonStyle(.golem(.secondary, .header))
                .disabled((session.inbox?.unread ?? 0) == 0)
            }
            .sharedBackgroundVisibility(.hidden)
        }
    }

    private func row(_ notification: InboxNotification) -> some View {
        let unread = notification.readAt == nil
        let topic = session.topics.first { $0.id == notification.topicId }?.name
        return Button {
            if unread { Task { await session.run { try await session.readNotifications(notification.id) } } }
            open(notification.destination)
        } label: {
            HStack(alignment: .top, spacing: Tokens.Space.lg) {
                GolemMark(size: Tokens.Mobile.Size.avatar)
                VStack(alignment: .leading, spacing: Tokens.Space.xxs) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(notification.title)
                            .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.semibold))
                            .foregroundStyle(Tokens.Mobile.Colors.title)
                            .lineLimit(1)
                        Spacer(minLength: Tokens.Space.md)
                        // The day, as the web's Inbox writes it.
                        Text(Date(milliseconds: notification.createdAt), format: .dateTime.day().month(.abbreviated))
                            .font(.golem(Tokens.Mobile.FontSize.caption))
                            .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                    }
                    if let topic {
                        Text("in # \(topic)")
                            .font(.golem(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.book))
                            .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                    }
                    Text(notification.text)
                        .font(.golem(Tokens.Mobile.FontSize.small))
                        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                Rectangle()
                    .fill(unread ? Tokens.Colors.accent : .clear)
                    .frame(width: Tokens.Size.dot * 1.5, height: Tokens.Size.dot * 1.5)
                    .padding(.top, Tokens.Space.sm)
                    .accessibilityLabel(unread ? "Unread" : "")
            }
            .padding(.horizontal, Tokens.Mobile.Size.margin)
            .padding(.vertical, Tokens.Space.lg)
            .contentShape(.rect)
        }
        .buttonStyle(.row)
        .transition(.opacity)
    }
}

extension InboxNotification {
    var destination: Destination { chatId.map { .chat($0) } ?? .topic(topicId) }
}
