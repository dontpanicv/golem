import AlarmKit

/// What Golem keeps with an alarm or a timer that it sets (`Alarms`); compiled into the app and the GolemActivity
/// extension, which shows a timer's countdown.
nonisolated struct GolemAlarm: AlarmMetadata {
    let label: String
}
