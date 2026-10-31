import ActivityKit
import SwiftUI
import WidgetKit

@main
struct GolemActivityBundle: WidgetBundle {
    var body: some Widget { ThreadActivity() }
}

/// The work for the person's message on the Lock Screen and in the Dynamic Island: what works now, how it goes, and
/// for how long. A tap opens the thread.
struct ThreadActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ThreadActivityAttributes.self) { context in
            HStack(spacing: Tokens.Space.lg) {
                StatusSymbol(status: context.state.status)
                    .font(.system(size: 22, weight: .semibold))
                VStack(alignment: .leading, spacing: Tokens.Space.xxs) {
                    Text(context.state.title)
                        .font(.golem(Tokens.Mobile.FontSize.body, Tokens.FontWeight.semibold))
                        .lineLimit(1)
                    StatusText(state: context.state)
                        .font(.golem(Tokens.Mobile.FontSize.small))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Elapsed(context: context)
                    .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium))
                    .foregroundStyle(.secondary)
            }
            .padding(Tokens.Space.xl)
            .widgetURL(context.attributes.url)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    StatusSymbol(status: context.state.status)
                        .font(.system(size: 22, weight: .semibold))
                        .padding(.leading, Tokens.Space.xs)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Elapsed(context: context)
                        .font(.golem(Tokens.Mobile.FontSize.small, Tokens.FontWeight.medium))
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.title)
                        .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.semibold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    StatusText(state: context.state)
                        .font(.golem(Tokens.Mobile.FontSize.small))
                        .foregroundStyle(.secondary)
                }
            } compactLeading: {
                StatusSymbol(status: context.state.status)
            } compactTrailing: {
                Elapsed(context: context)
                    .font(.golem(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.medium))
            } minimal: {
                StatusSymbol(status: context.state.status)
            }
            .widgetURL(context.attributes.url)
        }
    }
}

private typealias Status = ThreadActivityStatus

private struct StatusSymbol: View {
    let status: Status

    var body: some View {
        switch status {
        case .working:
            Image(systemName: "ellipsis")
                .symbolEffect(.variableColor.iterative.dimInactiveLayers, options: .repeating)
                .foregroundStyle(Tokens.Colors.accent)
        case .waiting:
            Image(systemName: "hand.raised.fill").foregroundStyle(Tokens.Colors.warning)
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Tokens.Colors.success)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Tokens.Colors.danger)
        }
    }
}

/// "Working", "Waiting for you", "Done", or "Failed", and how many threads work when there are more than one.
private struct StatusText: View {
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        let words = switch state.status {
        case .working: "Working"
        case .waiting: "Waiting for you"
        case .done: "Done"
        case .failed: "Failed"
        }
        Text(state.threads > 1 ? "\(words) · \(state.threads) threads" : words)
    }
}

/// The time since the message while the work goes on; nothing after it ends.
private struct Elapsed: View {
    let context: ActivityViewContext<ThreadActivityAttributes>

    var body: some View {
        if context.state.status == .working || context.state.status == .waiting {
            Text(timerInterval: context.attributes.startedAt...Date.distantFuture, countsDown: false)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 52)
        }
    }
}
