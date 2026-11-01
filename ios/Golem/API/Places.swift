import CoreLocation
import Foundation

/// The person's own places in the workspace, which they mark with a pin on a map and share or keep private, and the
/// ones other members shared.
extension APIClient {
    func places(workspaceID: String) async throws -> [Place] {
        let found: Places = try await get("/api/v1/workspaces/\(workspaceID)/places")
        return found.places
    }

    /// Adds a place, or changes the person's own place when `placeID` is set.
    func savePlace(workspaceID: String, placeID: String?, _ place: Place.Input) async throws -> Place {
        let body: [String: Any] = [
            "name": place.name, "latitude": place.latitude, "longitude": place.longitude, "radius": place.radius,
            "shared": place.shared
        ]
        let path = "/api/v1/workspaces/\(workspaceID)/places"
        return try decode(
            try await send(placeID == nil ? "POST" : "PUT", placeID.map { "\(path)/\($0)" } ?? path, body).data
        )
    }

    func removePlace(workspaceID: String, placeID: String) async throws {
        _ = try await send("DELETE", "/api/v1/workspaces/\(workspaceID)/places/\(placeID)")
    }

    /// Tells Golem that the person arrived at or left the place of their reminder, which is then due.
    func triggerReminder(workspaceID: String, reminderID: String) async throws {
        _ = try await send("POST", "/api/v1/workspaces/\(workspaceID)/reminders/\(reminderID)/trigger")
    }
}

struct Place: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let latitude: Double
    let longitude: Double
    /// The radius of its circle, in meters.
    let radius: Int
    /// The person who added it; only they change or remove it.
    let ownerId: String
    let ownerName: String
    /// Whether every member's turns use it; else only its owner's.
    var shared: Bool

    struct Input {
        var name: String
        var latitude: Double
        var longitude: Double
        var radius: Int
        var shared: Bool
    }

    var input: Input { Input(name: name, latitude: latitude, longitude: longitude, radius: radius, shared: shared) }
    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}

private struct Places: Codable {
    let places: [Place]
}
