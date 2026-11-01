import CoreLocation
import MapKit
import SwiftUI

/// The person's own places, which they mark with a pin on a map and share with every member's turns or keep private,
/// and the ones other members shared. A reminder waits for a person to arrive at one or leave it.
struct PlacesSection: View {
    let workspaceID: String
    @Environment(Session.self) private var session
    @State private var places: [Place] = []
    @State private var editing: Editing?

    /// The place that the form changes, or none for a new one.
    private struct Editing: Identifiable {
        let place: Place?
        var id: String { place?.id ?? "" }
    }

    var body: some View {
        SettingsCard(title: "Places") {
            ForEach($places) { $place in
                if place.ownerId == session.user?.id {
                    SettingsRow(place.name, description: "\(place.radius) m · \(place.shared ? "Shared" : "Private")") {
                        Toggle("Private", isOn: Binding(get: { !place.shared }, set: { share($place, !$0) }))
                            .toggleStyle(.golemSwitch)
                            .labelsHidden()
                        GolemMenu {
                            MenuItem("Change place", systemImage: "mappin.and.ellipse") {
                                editing = Editing(place: place)
                            }
                            MenuItem("Remove place", systemImage: "trash", role: .destructive) { remove(place) }
                        } label: {
                            Label("Place actions", systemImage: "ellipsis")
                        }
                        .buttonStyle(.golem(.ghost, .icon))
                    }
                } else {
                    SettingsRow(place.name, description: "\(place.radius) m · Shared by \(place.ownerName)")
                }
            }
            HStack {
                Button("Add place", systemImage: "plus") { editing = Editing(place: nil) }
                    .buttonStyle(.golem(.ghost, .small))
                Spacer()
            }
            .padding(.horizontal, Tokens.Space.md)
            .padding(.vertical, Tokens.Space.lg)
        }
        .task { await session.run { places = try await session.api.places(workspaceID: workspaceID) } }
        .sheet(item: $editing) { editing in
            PlaceForm(workspaceID: workspaceID, place: editing.place) { _ in
                Task { await session.run { places = try await session.api.places(workspaceID: workspaceID) } }
            }
        }
    }

    private func share(_ place: Binding<Place>, _ shared: Bool) {
        var input = place.wrappedValue.input
        input.shared = shared
        Task {
            await session.run {
                place.wrappedValue = try await session.api.savePlace(
                    workspaceID: workspaceID, placeID: place.wrappedValue.id, input
                )
            }
        }
    }

    private func remove(_ place: Place) {
        Task {
            await session.run {
                try await session.api.removePlace(workspaceID: workspaceID, placeID: place.id)
                places.removeAll { $0.id == place.id }
            }
        }
    }
}

/// Adds a place or changes one: its name, the pin in the middle of the map, which an address moves to, and the
/// radius of its circle.
struct PlaceForm: View {
    let workspaceID: String
    let place: Place?
    let saved: (Place) -> Void
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var pin: CLLocationCoordinate2D?
    @State private var radius: Int
    @State private var camera: MapCameraPosition
    /// The meters of one point of the map at its zoom, which sizes the place's circle.
    @State private var metersPerPoint: Double?
    @State private var address = ""
    @State private var busy = false
    @State private var location = CLLocationManager()

    /// The radii a person picks, in meters: iOS does not see a circle under 100 m reliably, and a cottage needs more.
    private static let radii = [100, 200, 300, 500, 1000, 2000]

    init(workspaceID: String, place: Place?, saved: @escaping (Place) -> Void) {
        self.workspaceID = workspaceID
        self.place = place
        self.saved = saved
        _name = State(initialValue: place?.name ?? "")
        _pin = State(initialValue: place?.coordinate)
        _radius = State(initialValue: place?.radius ?? 200)
        _camera = State(initialValue: place.map {
            .region(MKCoordinateRegion(center: $0.coordinate, latitudinalMeters: 1500, longitudinalMeters: 1500))
        } ?? .userLocation(fallback: .automatic))
    }

    var body: some View {
        Dialog(title: place?.name ?? "Add a place") {
            GolemTextField("Name", text: $name)
            // Return finds the address with Apple Maps and moves the map there; the person then moves the pin.
            GolemTextField("Address", placeholder: "Street, town", text: $address)
                .textContentType(.fullStreetAddress)
                .submitLabel(.search)
                .onSubmit(find)
            // The pin stays in the middle and the map moves under it, so a place always has a pin. Its circle is drawn
            // over the map, not in it: map content that follows the camera made the map report a change again, without
            // end, and the app froze.
            Map(position: $camera) {
                UserAnnotation()
            }
            .mapControls { MapUserLocationButton() }
            .onMapCameraChange(frequency: .continuous) { context in
                pin = context.region.center
                metersPerPoint = context.region.span.latitudeDelta * 111_320 / Tokens.Size.map
            }
            .overlay {
                ZStack {
                    if let metersPerPoint {
                        let diameter = 2 * Double(radius) / metersPerPoint
                        Circle()
                            .fill(Tokens.Colors.accent.opacity(0.12))
                            .stroke(Tokens.Colors.accent, lineWidth: 1.5)
                            .frame(width: diameter, height: diameter)
                    }
                    Circle()
                        .fill(Tokens.Colors.accent)
                        .stroke(.white, lineWidth: 2)
                        .frame(width: 16, height: 16)
                }
                .allowsHitTesting(false)
            }
            .frame(height: Tokens.Size.map)
            .clipShape(.rect(cornerRadius: Tokens.Radius.md))
            Picker("Radius", selection: $radius) {
                ForEach(Self.radii, id: \.self) { meters in
                    Text(meters < 1000 ? "\(meters) m" : "\(meters / 1000) km").tag(meters)
                }
            }
            .pickerStyle(.menu)
        } actions: {
            Button("Cancel") { dismiss() }.buttonStyle(.golem(.secondary, .large))
            Button(place == nil ? "Add place" : "Save", action: save)
                .buttonStyle(.golem(.primary, .large))
                .disabled(busy)
        }
        .onAppear {
            if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
        }
    }

    private func find() {
        let query = address.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return }
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        if let pin {
            // Near what the map shows first, so "Main Street" is the one in this town.
            request.region = MKCoordinateRegion(center: pin, latitudinalMeters: 50_000, longitudinalMeters: 50_000)
        }
        Task {
            guard let found = try? await MKLocalSearch(request: request).start().mapItems.first else {
                session.show("Golem did not find this address", .error)
                return
            }
            withAnimation {
                camera = .region(MKCoordinateRegion(
                    center: found.location.coordinate, latitudinalMeters: 1500, longitudinalMeters: 1500
                ))
            }
        }
    }

    private func save() {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else {
            session.show("Give the place a name", .error)
            return
        }
        guard let pin else { return }
        busy = true
        Task {
            await session.run {
                saved(try await session.api.savePlace(
                    workspaceID: workspaceID, placeID: place?.id,
                    Place.Input(
                        name: name, latitude: pin.latitude, longitude: pin.longitude, radius: radius,
                        shared: place?.shared ?? false
                    )
                ))
                dismiss()
            }
            busy = false
        }
    }
}
