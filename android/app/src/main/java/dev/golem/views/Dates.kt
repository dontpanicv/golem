package dev.golem.views

import java.text.DateFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

/** "9 Nov", as the web writes a day. */
fun shortDay(milliseconds: Double): String = format(milliseconds, "d MMM")

/** "Mon 9 Nov, 08:00": the weekday, the day, and the time in the phone's style. */
fun dayAndTime(milliseconds: Double): String = "${format(milliseconds, "EEE d MMM")}, ${timeOfDay(milliseconds)}"

/** The time alone, in the phone's style. */
fun timeOfDay(milliseconds: Double): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(milliseconds.toLong()))

/** The date and the time, short, in the phone's style. */
fun dateAndTime(milliseconds: Double): String =
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(milliseconds.toLong()))

private fun format(milliseconds: Double, pattern: String): String =
    DateTimeFormatter.ofPattern(pattern, Locale.getDefault())
        .format(Instant.ofEpochMilli(milliseconds.toLong()).atZone(ZoneId.systemDefault()))
