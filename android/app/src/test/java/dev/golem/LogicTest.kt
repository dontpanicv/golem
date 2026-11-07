package dev.golem

import dev.golem.api.Session
import dev.golem.api.Step
import dev.golem.views.Card
import dev.golem.views.duration
import dev.golem.views.linkedText
import dev.golem.views.runs
import dev.golem.views.withViewport
import dev.golem.views.withWorkingNotes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LogicTest {
    @Test
    fun challengeIsTheBase64UrlSha256OfTheVerifier() {
        // RFC 7636, appendix B.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Session.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        val verifier = Session.newVerifier()
        assertEquals(43, verifier.length)
        assertTrue(verifier.none { it == '+' || it == '/' || it == '=' })
    }

    @Test
    fun durationsReadAsTheWebWritesThem() {
        assertEquals("8s", duration(8.4))
        assertEquals("2m 05s", duration(125.0))
        assertEquals("1h 03m", duration(3780.0))
        assertEquals("0s", duration(-3.0))
    }

    @Test
    fun callsOfOneToolInARowFoldIntoOneRun() {
        fun tool(name: String) = Step(kind = "tool", text = "", tool = name)
        val steps = listOf(tool("web_search"), tool("web_search"), Step(kind = "text", text = "x"), tool("web_search"), tool("read_file"))
        assertEquals(listOf(2, 1, 1, 1), runs(steps).map { it.size })
    }

    @Test
    fun threadLinksShowTheirTitleAndWhetherTheyWork() {
        val text = "See [Trip](thread:abc-1) and [Home](thread:def)."
        assertEquals("See Trip and Home.", linkedText(text))
        assertEquals("See [Trip](thread:abc-1) *· working* and [Home](thread:def).", withWorkingNotes(text, setOf("abc-1")))
        assertEquals(text, withWorkingNotes(text, emptySet()))
    }

    @Test
    fun cardBlocksParseOneCardOrAList() {
        assertEquals("18 °C", Card.parse("""{"value":"18 °C","title":"Weather"}""")?.single()?.value)
        assertEquals(2, Card.parse("""[{"value":"1"},{"value":"2"}]""")?.size)
        assertNull(Card.parse("not json"))
    }

    @Test
    fun theViewportGoesAfterTheDoctype() {
        assertEquals("<!doctype html><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><p>", withViewport("<!doctype html><p>"))
        assertTrue(withViewport("<p>").startsWith("<meta name=\"viewport\""))
    }
}
