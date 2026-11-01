import AlarmKit
import SwiftUI
import WidgetKit

/// A timer or alarm that Golem set on the Lock Screen and in the Dynamic Island: its label and the time left. iOS
/// shows the ringing alarm itself.
struct AlarmActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AlarmAttributes<GolemAlarm>.self) { context in
            HStack(spacing: Tokens.Space.lg) {
                Image(systemName: "timer").font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Tokens.Colors.accent)
                Text(context.attributes.metadata?.label ?? "")
                    .font(.golem(Tokens.Mobile.FontSize.body, Tokens.FontWeight.semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Remaining(mode: context.state.mode)
                    .font(.golem(Tokens.Mobile.FontSize.title, Tokens.FontWeight.semibold))
            }
            .padding(Tokens.Space.xl)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "timer").font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(Tokens.Colors.accent)
                        .padding(.leading, Tokens.Space.xs)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.metadata?.label ?? "")
                        .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.semibold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Remaining(mode: context.state.mode)
                        .font(.golem(Tokens.Mobile.FontSize.row, Tokens.FontWeight.semibold))
                }
            } compactLeading: {
                Image(systemName: "timer").foregroundStyle(Tokens.Colors.accent)
            } compactTrailing: {
                Remaining(mode: context.state.mode)
                    .font(.golem(Tokens.Mobile.FontSize.caption, Tokens.FontWeight.medium))
                    .frame(maxWidth: 52)
            } minimal: {
                Image(systemName: "timer").foregroundStyle(Tokens.Colors.accent)
            }
        }
    }
}

/// The time left: counting down, still while paused, or the alarm's time.
private struct Remaining: View {
    let mode: AlarmPresentationState.Mode

    var body: some View {
        Group {
            switch mode {
            case let .countdown(countdown):
                Text(timerInterval: Date.now...countdown.fireDate, countsDown: true)
            case let .paused(paused):
                Text(Duration.seconds(paused.totalCountdownDuration - paused.previouslyElapsedDuration),
                     format: .time(pattern: .minuteSecond))
            case let .alert(alert):
                Text(String(format: "%02d:%02d", alert.time.hour, alert.time.minute))
            @unknown default:
                EmptyView()
            }
        }
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
    }
}
