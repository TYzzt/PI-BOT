package dev.tagent.android.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val clock: DateTimeFormatter = DateTimeFormatter.ofPattern("MM-dd HH:mm")

fun formatEpoch(millis: Long?): String {
    if (millis == null) return "尚未同步"
    return Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).format(clock)
}
