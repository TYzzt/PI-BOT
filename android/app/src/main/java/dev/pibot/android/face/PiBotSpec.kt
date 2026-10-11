package dev.pibot.android.face

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Mirrors `packages/bot-face/spec.json`; the app bundles that file as `assets/bot-face/spec.json`. */
@Serializable
data class PiBotSpec(
    val version: Int,
    val defaults: Defaults,
    val shapes: Map<String, ShapeSpec>,
    val colors: Map<String, ColorSpec>,
    val moods: Map<String, MoodSpec>,
    val confetti: List<String>,
) {
    @Serializable
    data class Defaults(val shape: String, val color: String, val scheme: String, val mood: String)

    @Serializable
    data class Face(val y: Double, val gap: Double, val eye: Double)

    @Serializable
    data class ShapeSpec(val label: String, val points: List<List<Double>>, val face: Face)

    @Serializable
    data class ColorSpec(val label: String, val light: List<String>, val dark: List<String>, val ink: String, val cheek: String)

    @Serializable
    data class MoodSpec(val label: String, val eyes: String, val mouth: String, val arms: String, val effect: String)

    fun shape(name: String): ShapeSpec = shapes[name] ?: shapes.getValue(defaults.shape)
    fun color(name: String): ColorSpec = colors[name] ?: colors.getValue(defaults.color)
    fun mood(name: String): MoodSpec = moods[name] ?: moods.getValue(defaults.mood)

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun parse(text: String): PiBotSpec = json.decodeFromString(serializer(), text)
    }
}

/** Order matters: it must match `SHAPES`, `COLORS` and `MOODS` in `packages/bot-face/src/spec.ts`. */
val SHAPES = listOf("blob", "pebble", "bean", "egg", "squircle", "cloud", "drop", "bell")
val COLORS = listOf("orange", "coral", "pink", "grape", "sky", "mint", "lime", "lemon", "cocoa", "ink")
val MOODS = listOf("idle", "happy", "thinking", "working", "searching", "waiting", "celebrate", "error", "sleeping")
val SCHEMES = listOf("light", "dark")

@Serializable
data class Avatar(val shape: String = "blob", val color: String = "orange", val scheme: String = "light") {
    fun normalized() = Avatar(
        shape.takeIf { it in SHAPES } ?: "blob",
        color.takeIf { it in COLORS } ?: "orange",
        scheme.takeIf { it in SCHEMES } ?: "light",
    )
}

/** Deterministic look for a seed (FNV-1a over UTF-16 code units of each code point), identical to `avatarFor` in TS. */
fun avatarFor(seed: String): Avatar {
    var h = 0x811C9DC5.toInt()
    var i = 0
    while (i < seed.length) {
        val cp = seed.codePointAt(i)
        h = (h xor seed[i].code) * 16777619
        i += Character.charCount(cp)
    }
    val unsigned = h.toLong() and 0xFFFFFFFFL
    return Avatar(SHAPES[(unsigned % SHAPES.size).toInt()], COLORS[(h ushr 8) % COLORS.size], "light")
}
