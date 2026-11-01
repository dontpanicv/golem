import CoreLocation
import UIKit
import UserNotifications

/// Watches the places of the person's pending reminders at a place with `CLMonitor`, and tells Golem when they arrive
/// or leave; only the event goes to Golem, never where the person is. iOS starts the app in the background for such an
/// event, also when it does not run, so `resume` runs at every launch.
final class PlaceWatcher {
    static let shared = PlaceWatcher()

    /// What the watcher keeps of a reminder across launches.
    private struct Watched: Codable {
        let workspaceID: String
        let text: String
        let event: ReminderPlace.Event
        /// Whether the person was in the circle when iOS last said; a new reminder starts outside.
        var inside: Bool
        /// The event came, but Golem did not get it; the app tells Golem again on the next `watch`.
        var unreported: Bool
    }

    private static let key = "watchedPlaces"
    private let manager = CLLocationManager()
    private var opening: Task<CLMonitor, Never>?
    private var session: CLServiceSession?
    /// The watched reminders, by id.
    private var watched: [String: Watched] = UserDefaults.standard.data(forKey: key)
        .flatMap { try? JSONDecoder().decode([String: Watched].self, from: $0) } ?? [:] {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(watched), forKey: Self.key) }
    }

    /// Opens the monitor at launch while it watches a reminder, so the event that started the app arrives.
    func resume() {
        if !watched.isEmpty { Task { _ = await monitor() } }
    }

    /// Watches the places of the person's pending reminders at a place in the workspace, stops watching the others,
    /// and tells Golem the events it did not get.
    func watch(_ reminders: [Reminder], userID: String, workspaceID: String) async {
        let unreported = watched.filter(\.value.unreported)
        for (id, item) in unreported {
            await report(id, item)
        }
        let wanted = reminders.filter {
            $0.recipientId == userID && $0.waitsForPlace && unreported[$0.id] == nil
        }
        guard !wanted.isEmpty || !watched.isEmpty else { return }
        if !wanted.isEmpty, [.notDetermined, .authorizedWhenInUse].contains(manager.authorizationStatus) {
            // iOS asks for While Using first, and for Always when the first event comes.
            manager.requestAlwaysAuthorization()
        }
        let monitor = await monitor()
        for id in await monitor.identifiers where watched[id]?.workspaceID ?? workspaceID == workspaceID
            && !wanted.contains(where: { $0.id == id }) {
            await monitor.remove(id)
            watched[id] = nil
        }
        for reminder in wanted where watched[reminder.id] == nil {
            guard let place = reminder.place else { continue }
            watched[reminder.id] = Watched(
                workspaceID: workspaceID, text: reminder.text, event: place.event, inside: false, unreported: false
            )
            // Assumed outside: one who is in the circle now gets an event at once, which an arrival reminds of.
            await monitor.add(
                CLMonitor.CircularGeographicCondition(
                    center: CLLocationCoordinate2D(latitude: place.latitude, longitude: place.longitude),
                    radius: CLLocationDistance(place.radius)
                ),
                identifier: reminder.id,
                assuming: .unsatisfied
            )
        }
        if watched.isEmpty {
            session?.invalidate()
            session = nil
        }
    }

    /// Stops watching every place, as after the person signs out.
    func stop() async {
        let monitor = await monitor()
        for id in await monitor.identifiers { await monitor.remove(id) }
        watched = [:]
        session?.invalidate()
        session = nil
    }

    /// The one monitor of the app, with a session that keeps its events coming in the background.
    private func monitor() async -> CLMonitor {
        session = session ?? CLServiceSession(authorization: .always)
        if let opening { return await opening.value }
        let opening = Task {
            let monitor = await CLMonitor("places")
            Task {
                for try await event in await monitor.events { await handle(event) }
            }
            return monitor
        }
        self.opening = opening
        return await opening.value
    }

    private func handle(_ event: CLMonitor.Event) async {
        guard var item = watched[event.identifier], !item.unreported, event.state != .unknown else { return }
        let inside = event.state == .satisfied
        let happened = inside != item.inside && inside == (item.event == .arrive)
        item.inside = inside
        item.unreported = happened
        watched[event.identifier] = item
        guard happened else { return }
        await monitor().remove(event.identifier)
        if !(await report(event.identifier, item)) {
            // Without a connection, as in the mountains, the person still gets the reminder.
            let content = UNMutableNotificationContent()
            content.title = "Golem"
            content.body = item.text
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: event.identifier, content: content, trigger: nil)
            )
        }
    }

    /// Tells Golem that a reminder's event came, in the time iOS gives a background app; forgets it once Golem has it.
    @discardableResult
    private func report(_ id: String, _ item: Watched) async -> Bool {
        let task = UIApplication.shared.beginBackgroundTask()
        defer { UIApplication.shared.endBackgroundTask(task) }
        do {
            try await APIClient.signedIn().triggerReminder(workspaceID: item.workspaceID, reminderID: id)
        } catch let error as APIError where error.status == 404 || error.status == 409 {
            // Cancelled, or no longer the person's.
        } catch {
            return false
        }
        watched[id] = nil
        return true
    }
}
