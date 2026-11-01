import HealthKit

/// Apple Health (HealthKit): daily values, sleep, workouts, and the values that the person logs. iOS never says
/// whether the person allowed a read: a type they did not allow reads as empty.
enum PhoneHealth {
    private struct ReadArguments: Decodable {
        let metric: String
        let from: String
        let to: String
    }

    private struct LogArguments: Decodable {
        let metric: String
        let value: Double
        let at: String?
    }

    private struct Quantity {
        let type: HKQuantityTypeIdentifier
        let unit: HKUnit
        let unitName: String
        /// Summed per day, such as steps; else the day's average, minimum, and maximum, such as heart rate.
        let cumulative: Bool
        /// Percentages are stored as fractions.
        var factor = 1.0
    }

    private struct Day: Encodable {
        let date: String
        let total: Double?
        let average: Double?
        let minimum: Double?
        let maximum: Double?
        let unit: String
    }

    private struct Night: Encodable {
        let date: String
        let asleepMinutes: Int
        let inBedMinutes: Int
        let deepMinutes: Int
        let remMinutes: Int
    }

    private struct Workout: Encodable {
        let activity: String
        let start: Date
        let end: Date
        let minutes: Int
        let kilocalories: Int?
        let kilometers: Double?
    }

    private static let store = HKHealthStore()
    private static let quantities: [String: Quantity] = [
        "steps": Quantity(type: .stepCount, unit: .count(), unitName: "steps", cumulative: true),
        "distance": Quantity(type: .distanceWalkingRunning, unit: .meterUnit(with: .kilo), unitName: "km", cumulative: true),
        "active_energy": Quantity(type: .activeEnergyBurned, unit: .kilocalorie(), unitName: "kcal", cumulative: true),
        "flights": Quantity(type: .flightsClimbed, unit: .count(), unitName: "flights", cumulative: true),
        "exercise_minutes": Quantity(type: .appleExerciseTime, unit: .minute(), unitName: "min", cumulative: true),
        "heart_rate": Quantity(type: .heartRate, unit: perMinute, unitName: "bpm", cumulative: false),
        "resting_heart_rate": Quantity(type: .restingHeartRate, unit: perMinute, unitName: "bpm", cumulative: false),
        "heart_rate_variability": Quantity(
            type: .heartRateVariabilitySDNN, unit: .secondUnit(with: .milli), unitName: "ms", cumulative: false
        ),
        "respiratory_rate": Quantity(type: .respiratoryRate, unit: perMinute, unitName: "breaths/min", cumulative: false),
        "oxygen_saturation": Quantity(type: .oxygenSaturation, unit: .percent(), unitName: "%", cumulative: false, factor: 100),
        "weight": Quantity(type: .bodyMass, unit: .gramUnit(with: .kilo), unitName: "kg", cumulative: false),
        "body_fat": Quantity(type: .bodyFatPercentage, unit: .percent(), unitName: "%", cumulative: false, factor: 100),
        "water": Quantity(type: .dietaryWater, unit: .literUnit(with: .milli), unitName: "ml", cumulative: true),
        "caffeine": Quantity(type: .dietaryCaffeine, unit: .gramUnit(with: .milli), unitName: "mg", cumulative: true),
    ]
    private static let perMinute = HKUnit.count().unitDivided(by: .minute())
    private static let mindful = HKCategoryType(.mindfulSession)
    private static let sleep = HKCategoryType(.sleepAnalysis)
    /// What Golem logs: water, caffeine, weight, body fat, and mindful minutes.
    private static let written: Set<HKSampleType> = [
        HKQuantityType(.dietaryWater), HKQuantityType(.dietaryCaffeine), HKQuantityType(.bodyMass),
        HKQuantityType(.bodyFatPercentage), mindful,
    ]

    static func read(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(ReadArguments.self)
        try await authorize()
        let from = try PhoneLink.date(arguments.from), to = try PhoneLink.date(arguments.to)
        let range = HKQuery.predicateForSamples(withStart: from, end: to)
        switch arguments.metric {
        case "sleep": return try .json(try await nights(range))
        case "workouts": return try .json(try await workouts(range))
        case "mindful_minutes":
            let samples = try await HKSampleQueryDescriptor(
                predicates: [.categorySample(type: mindful, predicate: range)], sortDescriptors: [SortDescriptor(\.startDate)]
            ).result(for: store)
            let days = Dictionary(grouping: samples) { day($0.startDate) }
            return try .json(days.keys.sorted().map { date in
                let minutes = days[date]!.reduce(0) { $0 + $1.endDate.timeIntervalSince($1.startDate) } / 60
                return Day(date: date, total: minutes.rounded(), average: nil, minimum: nil, maximum: nil, unit: "min")
            })
        default:
            guard let quantity = quantities[arguments.metric] else { throw PhoneError("There is no metric \(arguments.metric).") }
            return try .json(try await days(quantity, from: from, range: range))
        }
    }

    static func log(_ call: PhoneCall) async throws -> PhoneAnswer {
        let arguments = try call.arguments(LogArguments.self)
        try await authorize()
        let at = try arguments.at.map(PhoneLink.date) ?? .now
        let sample: HKSample
        if arguments.metric == "mindful_minutes" {
            sample = HKCategorySample(
                type: mindful, value: HKCategoryValue.notApplicable.rawValue,
                start: at.addingTimeInterval(-arguments.value * 60), end: at
            )
        } else {
            guard let quantity = quantities[arguments.metric],
                  written.contains(HKQuantityType(quantity.type)) else {
                throw PhoneError("Golem cannot log \(arguments.metric).")
            }
            sample = HKQuantitySample(
                type: HKQuantityType(quantity.type),
                quantity: HKQuantity(unit: quantity.unit, doubleValue: arguments.value / quantity.factor),
                start: at, end: at
            )
        }
        do {
            try await store.save(sample)
        } catch {
            throw PhoneError("Health did not save it: \(error.localizedDescription). The person allows it in Settings › Apps › Health › Data Access › Golem.")
        }
        return PhoneAnswer(text: "Logged in Health.")
    }

    private static func days(_ quantity: Quantity, from: Date, range: NSPredicate) async throws -> [Day] {
        let type = HKQuantityType(quantity.type)
        let collection = try await HKStatisticsCollectionQueryDescriptor(
            predicate: .quantitySample(type: type, predicate: range),
            options: quantity.cumulative ? .cumulativeSum : [.discreteAverage, .discreteMin, .discreteMax],
            anchorDate: Calendar.current.startOfDay(for: from),
            intervalComponents: DateComponents(day: 1)
        ).result(for: store)
        let value = { (amount: HKQuantity?) in amount.map { ($0.doubleValue(for: quantity.unit) * quantity.factor * 10).rounded() / 10 } }
        return collection.statistics().compactMap { statistics in
            let total = value(statistics.sumQuantity()), average = value(statistics.averageQuantity())
            guard total != nil || average != nil else { return nil }
            return Day(
                date: day(statistics.startDate), total: total, average: average,
                minimum: value(statistics.minimumQuantity()), maximum: value(statistics.maximumQuantity()),
                unit: quantity.unitName
            )
        }
    }

    /// Sleep by the day the person woke up.
    private static func nights(_ range: NSPredicate) async throws -> [Night] {
        let samples = try await HKSampleQueryDescriptor(
            predicates: [.categorySample(type: sleep, predicate: range)], sortDescriptors: [SortDescriptor(\.startDate)]
        ).result(for: store)
        let nights = Dictionary(grouping: samples) { day($0.endDate) }
        return nights.keys.sorted().map { date in
            func minutes(_ values: [HKCategoryValueSleepAnalysis]) -> Int {
                Int(nights[date]!.filter { values.map(\.rawValue).contains($0.value) }
                    .reduce(0) { $0 + $1.endDate.timeIntervalSince($1.startDate) } / 60)
            }
            return Night(
                date: date,
                asleepMinutes: minutes(HKCategoryValueSleepAnalysis.allAsleepValues.map { $0 }),
                inBedMinutes: minutes([.inBed]),
                deepMinutes: minutes([.asleepDeep]),
                remMinutes: minutes([.asleepREM])
            )
        }
    }

    private static func workouts(_ range: NSPredicate) async throws -> [Workout] {
        let samples = try await HKSampleQueryDescriptor(
            predicates: [.workout(range)], sortDescriptors: [SortDescriptor(\.startDate)]
        ).result(for: store)
        return samples.map { workout in
            let energy = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()
            let distance = workout.statistics(for: HKQuantityType(.distanceWalkingRunning))?.sumQuantity()
                ?? workout.statistics(for: HKQuantityType(.distanceCycling))?.sumQuantity()
                ?? workout.statistics(for: HKQuantityType(.distanceSwimming))?.sumQuantity()
            return Workout(
                activity: activity(workout.workoutActivityType),
                start: workout.startDate,
                end: workout.endDate,
                minutes: Int(workout.duration / 60),
                kilocalories: energy.map { Int($0.doubleValue(for: .kilocalorie())) },
                kilometers: distance.map { ($0.doubleValue(for: .meterUnit(with: .kilo)) * 100).rounded() / 100 }
            )
        }
    }

    private static func activity(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: "running"
        case .walking: "walking"
        case .cycling: "cycling"
        case .swimming: "swimming"
        case .hiking: "hiking"
        case .yoga: "yoga"
        case .traditionalStrengthTraining, .functionalStrengthTraining: "strength training"
        case .highIntensityIntervalTraining: "HIIT"
        case .elliptical: "elliptical"
        case .rowing: "rowing"
        case .dance, .cardioDance, .socialDance: "dance"
        case .pilates: "pilates"
        case .tennis: "tennis"
        case .soccer: "soccer"
        case .crossCountrySkiing, .downhillSkiing: "skiing"
        case .snowboarding: "snowboarding"
        case .climbing: "climbing"
        case .coreTraining: "core training"
        case .mindAndBody: "mind and body"
        case .stairClimbing, .stairs: "stairs"
        default: "other"
        }
    }

    private static func day(_ date: Date) -> String {
        date.formatted(.iso8601.year().month().day())
    }

    private static func authorize() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw PhoneError("This phone has no Health data.") }
        let read: Set<HKObjectType> = Set(quantities.values.map { HKQuantityType($0.type) })
            .union([mindful, sleep, HKWorkoutType.workoutType(), HKQuantityType(.distanceCycling), HKQuantityType(.distanceSwimming)])
        // iOS asks only for the types that the person was not asked about yet.
        try await store.requestAuthorization(toShare: written, read: read)
    }
}
