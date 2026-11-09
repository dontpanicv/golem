package dev.golem

import dev.golem.api.Llm
import dev.golem.api.Machine
import dev.golem.api.Usage
import dev.golem.views.Mercator
import dev.golem.views.lastDays
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate

class SettingsLogicTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

    @Test
    fun mercatorGoesBackToTheSamePoint() {
        val latitude = 50.0755
        val longitude = 14.4378
        assertEquals(latitude, Mercator.latitude(Mercator.y(latitude)), 1e-9)
        assertEquals(longitude, Mercator.longitude(Mercator.x(longitude)), 1e-9)
    }

    @Test
    fun mercatorPutsTheEquatorAndTheDateLineInTheMiddle() {
        assertEquals(0.5, Mercator.x(0.0), 1e-12)
        assertEquals(0.5, Mercator.y(0.0), 1e-12)
        // At zoom 15 Prague is in tile x 17698, y 11102 (the slippy map formula with asinh).
        assertEquals(17698, (Mercator.x(14.4378) * (1 shl 15)).toInt())
        assertEquals(11102, (Mercator.y(50.0755) * (1 shl 15)).toInt())
    }

    @Test
    fun aPixelAtTheEquatorOfZoomZeroIsAboutOneHundredFiftySixKilometers() {
        assertEquals(156_543.0, Mercator.metersPerPixel(0.0, 256.0), 1.0)
    }

    @Test
    fun lastDaysAreOldestFirstAndEndToday() {
        assertEquals(listOf("2026-02-27", "2026-02-28", "2026-03-01"), lastDays(3, LocalDate.of(2026, 3, 1)))
    }

    @Test
    fun usageAddsItsTokensAndCacheRate() {
        val usage = json.decodeFromString<Usage>(
            """{"days":[],"total":{"input":100,"output":50,"cacheRead":300,"cacheWrite":50,"cost":1.5},
            "sources":[],"models":[],"chats":[],"people":null}"""
        )
        assertEquals(500.0, usage.total.tokens, 0.0)
        assertEquals(0.75, usage.total.cacheRate, 1e-12)
    }

    @Test
    fun machineReadsItsSystemFromOs() {
        val machine = json.decodeFromString<Machine>(
            """{"id":"m","name":"Mac","os":"macos","arch":"arm64","version":"0.5.0","pairedBy":"u","pairedByName":"A","shared":false}"""
        )
        assertEquals("macOS arm64 · hands 0.5.0", machine.summary)
    }

    @Test
    fun llmReadsAWaitingLogin() {
        val llm = json.decodeFromString<Llm>(
            """{"connected":false,"owner":true,"provider":"ChatGPT","model":"m","effort":"high","models":[],
            "login":{"userCode":"AB-CD","verificationUri":"https://example.com/device","expiresAt":1},"error":null}"""
        )
        assertEquals("AB-CD", llm.login?.userCode)
    }
}
