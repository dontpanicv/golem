import CoreLocation
import MapKit

/// Where the phone is now (Core Location) and directions in Apple Maps (MapKit). Golem keeps no location: the answer
/// goes only to the turn that asked.
enum PhoneLocation {
    private struct Here: Encodable {
        let latitude: Double
        let longitude: Double
        let accuracyMeters: Int
        let address: String?
    }

    private struct DirectionsArguments: Decodable {
        let destination: String
        let mode: String?
    }

    static func current(_: PhoneCall) async throws -> PhoneAnswer {
        let session = CLServiceSession(authorization: .whenInUse)
        defer { session.invalidate() }
        var found: CLLocation?
        for try await update in CLLocationUpdate.liveUpdates() {
            if update.authorizationDenied || update.authorizationDeniedGlobally {
                throw PhoneError("The person did not allow Golem to use the location: Settings › Apps › Golem › Location.")
            }
            if let location = update.location, location.horizontalAccuracy <= 100 || update.stationary {
                found = location
                break
            }
        }
        guard let location = found else { throw PhoneError("The phone found no location.") }
        let item = try? await MKReverseGeocodingRequest(location: location)?.mapItems.first
        return try .json(Here(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracyMeters: Int(location.horizontalAccuracy),
            address: item?.address?.fullAddress.replacingOccurrences(of: "\n", with: ", ")
        ))
    }

    static func directions(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(DirectionsArguments.self)
        let item = try await place(arguments.destination)
        let mode = switch arguments.mode ?? "driving" {
        case "walking": MKLaunchOptionsDirectionsModeWalking
        case "transit": MKLaunchOptionsDirectionsModeTransit
        case "cycling": MKLaunchOptionsDirectionsModeCycling
        default: MKLaunchOptionsDirectionsModeDriving
        }
        return PhoneAnswer(text: "Maps shows the way to \(item.name ?? arguments.destination).") {
            _ = item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: mode])
        }
    }

    /// A latitude,longitude pair, or the first place that Apple Maps finds for an address or a name.
    private static func place(_ destination: String) async throws -> MKMapItem {
        let numbers = destination.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        if numbers.count == 2 {
            return MKMapItem(location: CLLocation(latitude: numbers[0], longitude: numbers[1]), address: nil)
        }
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = destination
        guard let item = try await MKLocalSearch(request: request).start().mapItems.first else {
            throw PhoneError("Apple Maps found no \(destination).")
        }
        return item
    }
}
