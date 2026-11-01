import CoreLocation
import UIKit
import UserNotifications

/// Watches the places that Golem gives for the person (`watched-places`) with `CLMonitor`, and tells Golem when they
/// arrive or leave; only that goes to Golem, never where the person is, and Golem decides what is due. iOS starts the
/// app in the background for such an event, also when it does not run, so `resume` runs at every launch.
final class PlaceWatcher {
    static let shared = PlaceWatcher()

    /// What the watcher keeps of a place across launches.
    private struct Watched: Codable {
        let workspaceID: String
        var place: WatchedPlace
        /// Whether the person was in the circle when iOS last said; nil until iOS first says after the watch starts.
        var inside: Bool?
    }

    /// What the iPhone saw at a place; it waits here until Golem has it, as without a connection.
    private struct Report: Codable, Equatable {
        let workspaceID: String
        let placeID: String
        let event: PlaceEvent
        /// When it happened, in Unix milliseconds.
        let time: Double
        /// The first state after the watch started, which is no crossing.
        let initial: Bool
    }

    private static let watchedKey = "watchedPlaces"
    private static let reportsKey = "placeReports"
    private let manager = CLLocationManager()
    private var opening: Task<CLMonitor, Never>?
    private var session: CLServiceSession?
    /// The watched places, by id.
    private var watched: [String: Watched] = stored(watchedKey) ?? [:] {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(watched), forKey: Self.watchedKey) }
    }
    /// The reports that Golem did not get yet, oldest first.
    private var reports: [Report] = stored(reportsKey) ?? [] {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(reports), forKey: Self.reportsKey) }
    }

    /// Opens the monitor at launch while it watches a place, so the event that started the app arrives.
    func resume() {
        if !watched.isEmpty { Task { _ = await monitor() } }
    }

    /// Watches the places that Golem gives for the person in the workspace, stops watching the others, and sends the
    /// reports that Golem did not get.
    func watch(_ places: [WatchedPlace], workspaceID: String) async {
        await sendReports()
        let wanted = Dictionary(places.map { ($0.id, $0) }) { first, _ in first }
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
        for (id, place) in wanted {
            if let item = watched[id], item.workspaceID == workspaceID, Self.sameCircle(item.place, place) {
                // The same circle, maybe with other reminders.
                watched[id]?.place = place
                continue
            }
            watched[id] = Watched(workspaceID: workspaceID, place: place, inside: nil)
            // iOS finds out first whether the person is in the circle, and says so as the first event.
            await monitor.add(
                CLMonitor.CircularGeographicCondition(
                    center: CLLocationCoordinate2D(latitude: place.latitude, longitude: place.longitude),
                    radius: CLLocationDistance(place.radius)
                ),
                identifier: id,
                assuming: .unknown
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
        reports = []
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
        guard var item = watched[event.identifier], event.state != .unknown else { return }
        let inside = event.state == .satisfied
        guard inside != item.inside else { return }
        let report = Report(
            workspaceID: item.workspaceID, placeID: event.identifier, event: inside ? .arrive : .leave,
            time: event.date.timeIntervalSince1970 * 1000, initial: item.inside == nil
        )
        item.inside = inside
        watched[event.identifier] = item
        reports.append(report)
        await sendReports()
        guard reports.contains(report) else { return }
        // Without a connection, as in the mountains, the person still gets the reminders that Golem would make due.
        let due = item.place.reminders.filter {
            $0.event == report.event && (!report.initial || report.event == .arrive)
        }
        for reminder in due {
            let content = UNMutableNotificationContent()
            content.title = "Golem"
            content.body = reminder.text
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: reminder.id, content: content, trigger: nil)
            )
        }
        watched[event.identifier]?.place.reminders.removeAll { due.contains($0) }
    }

    /// Sends the waiting reports in order, in the time iOS gives a background app, until one cannot go.
    private func sendReports() async {
        guard !reports.isEmpty else { return }
        let task = UIApplication.shared.beginBackgroundTask()
        defer { UIApplication.shared.endBackgroundTask(task) }
        let api = APIClient.signedIn()
        for report in reports {
            do {
                try await api.reportPlace(
                    workspaceID: report.workspaceID, placeID: report.placeID, event: report.event, at: report.time,
                    initial: report.initial
                )
            } catch let error as APIError where error.status == 400 || error.status == 404 {
                // Golem no longer watches the place for the person.
            } catch {
                return
            }
            reports.removeAll { $0 == report }
        }
    }

    private static func sameCircle(_ first: WatchedPlace, _ second: WatchedPlace) -> Bool {
        first.latitude == second.latitude && first.longitude == second.longitude && first.radius == second.radius
    }

    private static func stored<Value: Decodable>(_ key: String) -> Value? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(Value.self, from: $0) }
    }
}
