import HomeKit

/// Apple Home (HomeKit): the homes, their accessories and scenes; it runs scenes and turns accessories on or off.
enum PhoneHome {
    private struct SceneArguments: Decodable {
        let name: String
        let home: String?
    }

    private struct PowerArguments: Decodable {
        let accessory: String
        let on: Bool
        let home: String?
    }

    private struct Home: Encodable {
        let name: String
        let primary: Bool
        let rooms: [String]
        let accessories: [Accessory]
        let scenes: [String]
    }

    private struct Accessory: Encodable {
        let name: String
        let room: String?
        let kind: String
        let reachable: Bool
        let on: Bool?
    }

    private static let loader = Loader()

    static func list(_: PhoneCall) async throws -> PhoneAnswer {
        let homes = try await loader.homes()
        var listed: [Home] = []
        for home in homes {
            var accessories: [Accessory] = []
            for accessory in home.accessories {
                var on: Bool?
                if let power = power(accessory) {
                    if accessory.isReachable { try? await power.readValue() }
                    on = power.value as? Bool
                }
                accessories.append(Accessory(
                    name: accessory.name, room: accessory.room?.name, kind: accessory.category.localizedDescription,
                    reachable: accessory.isReachable, on: on
                ))
            }
            listed.append(Home(
                name: home.name, primary: home.isPrimary, rooms: home.rooms.map(\.name), accessories: accessories,
                scenes: home.actionSets.map(\.name)
            ))
        }
        return try .json(listed)
    }

    static func scene(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(SceneArguments.self)
        let home = try await home(arguments.home)
        guard let scene = home.actionSets.first(where: { same($0.name, arguments.name) }) else {
            throw PhoneError("\(home.name) has no scene \(arguments.name): \(home.actionSets.map(\.name).joined(separator: ", ")).")
        }
        try await home.executeActionSet(scene)
        return PhoneAnswer(text: "Ran \(scene.name).")
    }

    static func power(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(PowerArguments.self)
        let home = try await home(arguments.home)
        let found = home.accessories.first { same($0.name, arguments.accessory) }
            ?? home.accessories.first { same("\($0.room?.name ?? "") \($0.name)", arguments.accessory) }
        guard let accessory = found, let power = power(accessory) else {
            throw PhoneError("\(home.name) has no accessory \(arguments.accessory) that turns on and off.")
        }
        try await power.writeValue(arguments.on)
        return PhoneAnswer(text: "\(accessory.name) is \(arguments.on ? "on" : "off").")
    }

    private static func home(_ name: String?) async throws -> HMHome {
        let homes = try await loader.homes()
        guard let home = name.map({ name in homes.first { same($0.name, name) } }) ?? homes.first(where: \.isPrimary) ?? homes.first
        else { throw PhoneError("There is no home \(name ?? "") in Apple Home.") }
        return home
    }

    private static func power(_ accessory: HMAccessory) -> HMCharacteristic? {
        accessory.services.lazy.flatMap(\.characteristics)
            .first { $0.characteristicType == HMCharacteristicTypePowerState }
    }

    private static func same(_ one: String, _ other: String) -> Bool {
        one.localizedCaseInsensitiveCompare(other) == .orderedSame
    }

    /// The home manager, whose homes come only after its delegate hears from it.
    private final class Loader: NSObject, HMHomeManagerDelegate {
        private var manager: HMHomeManager?
        private var loaded = false
        private var waiting: [CheckedContinuation<Void, Never>] = []

        func homes() async throws -> [HMHome] {
            if manager == nil {
                let manager = HMHomeManager()
                manager.delegate = self
                self.manager = manager
            }
            if !loaded { await withCheckedContinuation { waiting.append($0) } }
            guard let manager, manager.authorizationStatus.contains(.authorized) else {
                throw PhoneError("The person did not allow Golem to use Apple Home: Settings › Apps › Golem › Home Data.")
            }
            return manager.homes
        }

        func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
            loaded = true
            waiting.forEach { $0.resume() }
            waiting = []
        }

        func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) {
            // A refused prompt sends no homes; the waiting calls end with the refusal.
            if status.contains(.determined), !status.contains(.authorized) { homeManagerDidUpdateHomes(manager) }
        }
    }
}
