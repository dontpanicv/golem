package dev.golem.phone

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Volume
import kotlinx.serialization.Serializable
import java.time.Duration
import java.time.Instant
import java.time.Period
import java.time.ZoneId
import kotlin.math.roundToInt
import kotlin.reflect.KClass

/**
 * Health Connect: daily values, sleep, workouts, and the values that the person logs. It asks for each kind of data
 * when a tool first needs it.
 */
@OptIn(ExperimentalMindfulnessSessionApi::class)
object PhoneHealth {
    @Serializable
    private data class ReadArguments(val metric: String, val from: String, val to: String)

    @Serializable
    private data class LogArguments(val metric: String, val value: Double, val at: String? = null)

    @Serializable
    data class Day(
        val date: String,
        val total: Double? = null,
        val average: Double? = null,
        val minimum: Double? = null,
        val maximum: Double? = null,
        val unit: String,
    )

    @Serializable
    private data class Night(
        val date: String,
        val asleepMinutes: Int,
        val inBedMinutes: Int,
        val deepMinutes: Int,
        val remMinutes: Int,
    )

    @Serializable
    private data class Workout(
        val activity: String,
        val start: String,
        val end: String,
        val minutes: Int,
        val kilocalories: Int? = null,
        val kilometers: Double? = null,
    )

    /** A value summed per day, such as steps, as Health Connect sums it across apps without counting one twice. */
    private class Total<T : Any>(val record: KClass<out Record>, val metric: AggregateMetric<T>, val unit: String, val value: (T) -> Double)

    /** A value whose day has an average, minimum, and maximum, such as heart rate, from its records' samples. */
    private class Samples<R : Record>(val record: KClass<R>, val unit: String, val samples: (R) -> List<Pair<Instant, Double>>)

    private val totals: Map<String, Total<*>> = mapOf(
        "steps" to Total(StepsRecord::class, StepsRecord.COUNT_TOTAL, "steps") { it.toDouble() },
        "distance" to Total(DistanceRecord::class, DistanceRecord.DISTANCE_TOTAL, "km") { it.inKilometers },
        "active_energy" to Total(ActiveCaloriesBurnedRecord::class, ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL, "kcal") {
            it.inKilocalories
        },
        "flights" to Total(FloorsClimbedRecord::class, FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL, "flights") { it },
        "exercise_minutes" to Total(ExerciseSessionRecord::class, ExerciseSessionRecord.EXERCISE_DURATION_TOTAL, "min") {
            it.toMinutes().toDouble()
        },
        "water" to Total(HydrationRecord::class, HydrationRecord.VOLUME_TOTAL, "ml") { it.inMilliliters },
        "caffeine" to Total(NutritionRecord::class, NutritionRecord.CAFFEINE_TOTAL, "mg") { it.inMilligrams },
        "mindful_minutes" to Total(MindfulnessSessionRecord::class, MindfulnessSessionRecord.MINDFULNESS_DURATION_TOTAL, "min") {
            it.toMinutes().toDouble()
        },
    )

    private val samples: Map<String, Samples<*>> = mapOf(
        "heart_rate" to Samples(HeartRateRecord::class, "bpm") { record ->
            record.samples.map { it.time to it.beatsPerMinute.toDouble() }
        },
        "resting_heart_rate" to Samples(RestingHeartRateRecord::class, "bpm") { listOf(it.time to it.beatsPerMinute.toDouble()) },
        "heart_rate_variability" to Samples(HeartRateVariabilityRmssdRecord::class, "ms") {
            listOf(it.time to it.heartRateVariabilityMillis)
        },
        "respiratory_rate" to Samples(RespiratoryRateRecord::class, "breaths/min") { listOf(it.time to it.rate) },
        "oxygen_saturation" to Samples(OxygenSaturationRecord::class, "%") { listOf(it.time to it.percentage.value) },
        "weight" to Samples(WeightRecord::class, "kg") { listOf(it.time to it.weight.inKilograms) },
        "body_fat" to Samples(BodyFatRecord::class, "%") { listOf(it.time to it.percentage.value) },
    )

    suspend fun read(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<ReadArguments>()
        val from = date(arguments.from)
        val to = date(arguments.to)
        val client = client(phone)
        val zone = ZoneId.systemDefault()
        return when (arguments.metric) {
            "sleep" -> {
                allow(phone, client, HealthPermission.getReadPermission(SleepSessionRecord::class))
                jsonAnswer(nights(records(client, SleepSessionRecord::class, from, to), zone))
            }
            "workouts" -> {
                allow(
                    phone, client, HealthPermission.getReadPermission(ExerciseSessionRecord::class),
                    HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
                    HealthPermission.getReadPermission(DistanceRecord::class),
                )
                jsonAnswer(records(client, ExerciseSessionRecord::class, from, to).map { workout(client, it) })
            }
            in totals -> {
                val total = totals.getValue(arguments.metric)
                if (total.record == MindfulnessSessionRecord::class) mindfulness(client)
                allow(phone, client, HealthPermission.getReadPermission(total.record))
                jsonAnswer(days(client, total, from, to, zone))
            }
            in samples -> {
                val kind = samples.getValue(arguments.metric)
                allow(phone, client, HealthPermission.getReadPermission(kind.record))
                jsonAnswer(dailyStatistics(sampled(client, kind, from, to), zone, kind.unit))
            }
            else -> throw PhoneError("There is no metric ${arguments.metric}.")
        }
    }

    suspend fun log(phone: Phone): PhoneAnswer {
        val arguments = phone.arguments<LogArguments>()
        val at = arguments.at?.let(::date) ?: Instant.now()
        val offset = ZoneId.systemDefault().rules.getOffset(at)
        val value = arguments.value
        val metadata = Metadata.manualEntry()
        val client = client(phone)
        // Records of a span need their start before their end.
        val record: Record = when (arguments.metric) {
            "water" -> HydrationRecord(at.minusSeconds(1), offset, at, offset, Volume.milliliters(value), metadata)
            "caffeine" -> NutritionRecord(
                startTime = at.minusSeconds(1), startZoneOffset = offset, endTime = at, endZoneOffset = offset,
                caffeine = Mass.milligrams(value), metadata = metadata,
            )
            "weight" -> WeightRecord(at, offset, Mass.kilograms(value), metadata)
            "body_fat" -> BodyFatRecord(at, offset, Percentage(value), metadata)
            "mindful_minutes" -> {
                mindfulness(client)
                MindfulnessSessionRecord(
                    startTime = at.minusSeconds((value * 60).toLong().coerceAtLeast(1)), startZoneOffset = offset,
                    endTime = at, endZoneOffset = offset, metadata = metadata,
                    mindfulnessSessionType = MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_UNKNOWN,
                )
            }
            else -> throw PhoneError("Golem cannot log ${arguments.metric}.")
        }
        allow(phone, client, HealthPermission.getWritePermission(record::class))
        try {
            client.insertRecords(listOf(record))
        } catch (error: Exception) {
            throw PhoneError("Health Connect did not save it: ${error.message}.")
        }
        return PhoneAnswer("Logged in Health Connect.")
    }

    /** Each day's value, as the day of the phone's time zone has it. */
    private suspend fun <T : Any> days(client: HealthConnectClient, total: Total<T>, from: Instant, to: Instant, zone: ZoneId): List<Day> =
        client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(
                metrics = setOf(total.metric),
                timeRangeFilter = TimeRangeFilter.between(from.atZone(zone).toLocalDateTime(), to.atZone(zone).toLocalDateTime()),
                timeRangeSlicer = Period.ofDays(1),
            )
        ).mapNotNull { group ->
            group.result[total.metric]?.let { Day(group.startTime.toLocalDate().toString(), total = tenth(total.value(it)), unit = total.unit) }
        }

    private suspend fun <R : Record> sampled(client: HealthConnectClient, kind: Samples<R>, from: Instant, to: Instant) =
        records(client, kind.record, from, to).flatMap(kind.samples).filter { it.first >= from && it.first < to }

    /** The average, minimum, and maximum of each day's samples, by the day of `zone`. */
    fun dailyStatistics(samples: List<Pair<Instant, Double>>, zone: ZoneId, unit: String): List<Day> =
        samples.groupBy { it.first.atZone(zone).toLocalDate() }.toSortedMap().map { (day, values) ->
            val numbers = values.map { it.second }
            Day(day.toString(), average = tenth(numbers.average()), minimum = tenth(numbers.min()), maximum = tenth(numbers.max()), unit = unit)
        }

    /** Sleep by the day the person woke up. */
    private fun nights(sessions: List<SleepSessionRecord>, zone: ZoneId): List<Night> =
        sessions.groupBy { it.endTime.atZone(zone).toLocalDate() }.toSortedMap().map { (day, nights) ->
            fun minutes(stages: Set<Int>) = nights.sumOf { night ->
                night.stages.filter { it.stage in stages }.sumOf { Duration.between(it.startTime, it.endTime).toMinutes() }
            }.toInt()
            val asleep = nights.sumOf { night ->
                // A session without stages is all asleep.
                if (night.stages.isEmpty()) Duration.between(night.startTime, night.endTime).toMinutes()
                else night.stages.filter { it.stage in ASLEEP }.sumOf { Duration.between(it.startTime, it.endTime).toMinutes() }
            }.toInt()
            val inBed = nights.sumOf { Duration.between(it.startTime, it.endTime).toMinutes() }.toInt() -
                minutes(setOf(SleepSessionRecord.STAGE_TYPE_OUT_OF_BED))
            Night(
                day.toString(), asleep, inBed, minutes(setOf(SleepSessionRecord.STAGE_TYPE_DEEP)),
                minutes(setOf(SleepSessionRecord.STAGE_TYPE_REM)),
            )
        }

    private suspend fun workout(client: HealthConnectClient, session: ExerciseSessionRecord): Workout {
        val result = client.aggregate(
            AggregateRequest(
                setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL, DistanceRecord.DISTANCE_TOTAL),
                TimeRangeFilter.between(session.startTime, session.endTime),
            )
        )
        return Workout(
            activity = ACTIVITIES[session.exerciseType] ?: "other",
            start = iso(session.startTime),
            end = iso(session.endTime),
            minutes = Duration.between(session.startTime, session.endTime).toMinutes().toInt(),
            kilocalories = result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories?.roundToInt(),
            kilometers = result[DistanceRecord.DISTANCE_TOTAL]?.let { (it.inKilometers * 100).roundToInt() / 100.0 },
        )
    }

    /** Every record of a kind in the time range, over all pages. */
    private suspend fun <R : Record> records(client: HealthConnectClient, type: KClass<R>, from: Instant, to: Instant): List<R> {
        val records = mutableListOf<R>()
        var page: String? = null
        do {
            val response = client.readRecords(ReadRecordsRequest(type, TimeRangeFilter.between(from, to), pageToken = page))
            records += response.records
            page = response.pageToken
        } while (page != null)
        return records
    }

    private fun client(phone: Phone): HealthConnectClient {
        if (HealthConnectClient.getSdkStatus(phone.context) != HealthConnectClient.SDK_AVAILABLE) {
            throw PhoneError("Health Connect is not on this phone, or it needs an update from the Play Store.")
        }
        return HealthConnectClient.getOrCreate(phone.context)
    }

    private fun mindfulness(client: HealthConnectClient) {
        if (client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_MINDFULNESS_SESSION) !=
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        ) throw PhoneError("Health Connect on this phone has no mindful minutes yet; it needs an update.")
    }

    /** Asks the person for the permissions that they did not give yet. */
    private suspend fun allow(phone: Phone, client: HealthConnectClient, vararg permissions: String) {
        val wanted = permissions.toSet()
        if (client.permissionController.getGrantedPermissions().containsAll(wanted)) return
        phone.result(PermissionController.createRequestPermissionResultContract(), wanted)
        if (!client.permissionController.getGrantedPermissions().containsAll(wanted)) {
            throw PhoneError("The person did not allow Golem this data in Health Connect: Settings › Apps › Golem › Permissions.")
        }
    }

    private val ACTIVITIES = with(ExerciseSessionRecord) {
        mapOf(
            EXERCISE_TYPE_RUNNING to "running", EXERCISE_TYPE_RUNNING_TREADMILL to "running", EXERCISE_TYPE_WALKING to "walking",
            EXERCISE_TYPE_BIKING to "cycling", EXERCISE_TYPE_BIKING_STATIONARY to "cycling",
            EXERCISE_TYPE_SWIMMING_POOL to "swimming", EXERCISE_TYPE_SWIMMING_OPEN_WATER to "swimming", EXERCISE_TYPE_HIKING to "hiking",
            EXERCISE_TYPE_YOGA to "yoga", EXERCISE_TYPE_STRENGTH_TRAINING to "strength training",
            EXERCISE_TYPE_WEIGHTLIFTING to "strength training", EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING to "HIIT",
            EXERCISE_TYPE_ELLIPTICAL to "elliptical", EXERCISE_TYPE_ROWING to "rowing", EXERCISE_TYPE_ROWING_MACHINE to "rowing",
            EXERCISE_TYPE_DANCING to "dance", EXERCISE_TYPE_PILATES to "pilates", EXERCISE_TYPE_TENNIS to "tennis",
            EXERCISE_TYPE_SOCCER to "soccer", EXERCISE_TYPE_SKIING to "skiing", EXERCISE_TYPE_SNOWBOARDING to "snowboarding",
            EXERCISE_TYPE_ROCK_CLIMBING to "climbing", EXERCISE_TYPE_STAIR_CLIMBING to "stairs",
            EXERCISE_TYPE_STAIR_CLIMBING_MACHINE to "stairs",
        )
    }

    private fun tenth(value: Double) = (value * 10).roundToInt() / 10.0

    private val ASLEEP = setOf(
        SleepSessionRecord.STAGE_TYPE_SLEEPING, SleepSessionRecord.STAGE_TYPE_LIGHT, SleepSessionRecord.STAGE_TYPE_DEEP,
        SleepSessionRecord.STAGE_TYPE_REM,
    )
}
