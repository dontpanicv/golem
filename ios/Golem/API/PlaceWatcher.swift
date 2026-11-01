import CoreLocation
import UIKit
import UserNotifications

/// What waits for the person at a place.
private enum WatchedKind: String, Codable { case reminder, routine }

/// Watches the places of the person's pending reminders and routines at a place with `CLMonitor`, and tells Golem when
/// they arrive or leave; only the event goes to Golem, never where the person is. iOS starts the app in the background
/// for such an event, also when it does not run, so `resume` runs at every launch.
final class PlaceWatcher {
    static let shared = PlaceWatcher()

    /// What the watcher keeps of a reminder or a routine across launches.
    private struct Watched: Codable {
        let kind: WatchedKind
        let workspaceID: String
        /// The reminder's text, or the routine's name.
        let text: String
        let event: PlaceEvent
        /// The latitude, longitude, and radius of the circle; a place that moved is watched again.
        let circle: [Double]
        /// Whether the person was in the circle when iOS last said. A new reminder starts outside; a new routine waits
        /// until iOS first says, so it runs only when the person next crosses the circle.
        var inside: Bool?
        /// The event of a reminder came, but Golem did not get it; the app tells Golem again on the next `watch`.
        var unreported: Bool
    }

    private static let key = "watchedPlaces"
    private let manager = CLLocationManager()
    private var opening: Task<CLMonitor, Never>?
    private var session: CLServiceSession?
    /// The watched reminders and routines, by id.
    private var watched: [String: Watched] = UserDefaults.standard.data(forKey: key)
        .flatMap { try? JSONDecoder().decode([String: Watched].self, from: $0) } ?? [:] {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(watched), forKey: Self.key) }
    }

    /// Opens the monitor at launch while it watches a place, so the event that started the app arrives.
    func resume() {
        if !watched.isEmpty { Task { _ = await monitor() } }
    }

    /// Watches the places of the person's pending reminders and enabled routines at a place in the workspace, stops
    /// watching the others, and tells Golem the events of reminders that it did not get.
    func watch(_ upcoming: Upcoming, userID: String, workspaceID: String) async {
        let unreported = watched.filter(\.value.unreported)
        for (id, item) in unreported {
            await report(id, item)
        }
        let reminders = upcoming.reminders.filter {
            $0.recipientId == userID && $0.waitsForPlace && unreported[$0.id] == nil
        }.compactMap { reminder in
            reminder.place.map { place in
                (reminder.id, Watched(
                    kind: .reminder, workspaceID: workspaceID, text: reminder.text, event: place.event,
                    circle: [place.latitude, place.longitude, Double(place.radius)], inside: false, unreported: false
                ))
            }
        }
        let routines = upcoming.routines.filter { $0.enabled && $0.place?.personId == userID }.compactMap { routine in
            routine.place.map { place in
                (routine.id, Watched(
                    kind: .routine, workspaceID: workspaceID, text: routine.name, event: place.event,
                    circle: [place.latitude, place.longitude, Double(place.radius)], inside: nil, unreported: false
                ))
            }
        }
        let wanted = Dictionary(reminders + routines) { first, _ in first }
        guard !wanted.isEmpty || !watched.isEmpty else { return }
        if !wanted.isEmpty, [.notDetermined, .authorizedWhenInUse].contains(manager.authorizationStatus) {
            // iOS asks for While Using first, and for Always when the first event comes.
            manager.requestAlwaysAuthorization()
        }
        let monitor = await monitor()
        for id in await monitor.identifiers where watched[id]?.workspaceID ?? workspaceID == workspaceID
            && wanted[id] == nil {
            await monitor.remove(id)
            watched[id] = nil
        }
        for (id, item) in wanted where watched[id]?.circle != item.circle {
            watched[id] = item
            // A reminder assumes outside: one who is in the circle now gets an event at once, which an arrival reminds
            // of. A routine lets iOS find out first.
            await monitor.add(
                CLMonitor.CircularGeographicCondition(
                    center: CLLocationCoordinate2D(latitude: item.circle[0], longitude: item.circle[1]),
                    radius: item.circle[2]
                ),
                identifier: id,
                assuming: item.kind == .reminder ? .unsatisfied : .unknown
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
        let happened = item.inside != nil && inside != item.inside && inside == (item.event == .arrive)
        item.inside = inside
        item.unreported = happened && item.kind == .reminder
        watched[event.identifier] = item
        guard happened else { return }
        guard item.kind == .reminder else {
            // shortcut: a routine that Golem does not hear of now does not run; queue it if late runs are wanted.
            await report(event.identifier, item)
            return
        }
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

    /// Tells Golem that the event of a reminder or a routine came, in the time iOS gives a background app; forgets a
    /// reminder once Golem has it, and keeps watching a routine.
    @discardableResult
    private func report(_ id: String, _ item: Watched) async -> Bool {
        let task = UIApplication.shared.beginBackgroundTask()
        defer { UIApplication.shared.endBackgroundTask(task) }
        do {
            let api = APIClient.signedIn()
            switch item.kind {
            case .reminder: try await api.triggerReminder(workspaceID: item.workspaceID, reminderID: id)
            case .routine: try await api.triggerRoutine(id)
            }
        } catch let error as APIError where error.status == 404 || error.status == 409 {
            // Cancelled or paused, or no longer the person's.
        } catch {
            return false
        }
        if item.kind == .reminder { watched[id] = nil }
        return true
    }
}
