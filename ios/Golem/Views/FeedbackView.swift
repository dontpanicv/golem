import SwiftUI

/// What the agents reported about Golem, newest first, for the server's owner: a tap opens the report's thread when
/// the owner sees it; the check dismisses it.
struct FeedbackView: View {
    let open: (Destination) -> Void
    @Environment(Session.self) private var session
    @State private var reports: [Feedback]?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                DetailTitle(title: "Feedback")
                    .padding(.horizontal, Tokens.Mobile.Size.margin)
                    .padding(.vertical, Tokens.Space.md)
                ForEach(reports ?? []) { row($0) }
            }
            .padding(.bottom, Tokens.Space.xxxl)
            .animation(.snappy, value: reports)
        }
        .returnsToEnd()
        .overlay {
            if reports?.isEmpty == true { EmptyState(title: "No feedback", systemImage: "info.circle") }
        }
        .task { await session.run { try await load() } }
        .refreshable { await session.run { try await load() } }
        .phoneTabBar()
        .mobileBackground()
        .pushedScreen("Feedback")
    }

    private func load() async throws {
        guard let workspace = session.workspace else { return }
        reports = try await session.api.feedback(workspaceID: workspace.id)
    }

    private func row(_ feedback: Feedback) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Button {
                if let threadID = feedback.threadId { open(.thread(threadID)) }
            } label: {
                HStack(alignment: .top, spacing: Tokens.Space.md) {
                    Image(systemName: feedback.kind.systemImage)
                        .font(.system(size: 15))
                        .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                        .frame(width: 21)
                    VStack(alignment: .leading, spacing: Tokens.Space.xxs) {
                        Text(feedback.summary)
                            .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.medium))
                            .foregroundStyle(Tokens.Mobile.Colors.title)
                        Text([feedback.kind.label, feedback.tool].compactMap { $0 }.joined(separator: " · "))
                            .font(.golem(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.book))
                            .foregroundStyle(Tokens.Mobile.Colors.textTertiary)
                        Text(feedback.detail)
                            .font(.golem(Tokens.Mobile.FontSize.small))
                            .foregroundStyle(Tokens.Mobile.Colors.textSecondary)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: Tokens.Space.md)
                    // The day, as the web's Feedback writes it.
                    Text(Date(milliseconds: feedback.createdAt), format: .dateTime.day().month(.abbreviated))
                        .font(.golem(Tokens.Mobile.FontSize.caption))
                        .foregroundStyle(Tokens.Mobile.Colors.textQuaternary)
                }
                .padding(.leading, Tokens.Mobile.Size.margin)
                .padding(.vertical, Tokens.Space.lg)
                .contentShape(.rect)
            }
            .buttonStyle(.row)
            .disabled(feedback.threadId == nil)
            Button("Dismiss", systemImage: "checkmark") { dismiss(feedback) }
                .labelStyle(.iconOnly)
                .buttonStyle(.golem(.ghost, .icon))
                .padding(.horizontal, Tokens.Mobile.Size.margin)
                .padding(.top, Tokens.Space.md)
        }
        .transition(.opacity)
    }

    private func dismiss(_ feedback: Feedback) {
        guard let workspace = session.workspace else { return }
        Task {
            await session.run {
                try await session.api.dismissFeedback(workspaceID: workspace.id, feedbackID: feedback.id)
                reports?.removeAll { $0.id == feedback.id }
            }
        }
    }
}

private extension Feedback.Kind {
    var label: String {
        switch self {
        case .error: "Error"
        case .missing: "Missing"
        case .better: "Better way"
        }
    }

    /// The SF Symbols of the web's icons.
    var systemImage: String {
        switch self {
        case .error: "info.circle"
        case .missing: "plus"
        case .better: "chevron.right"
        }
    }
}
