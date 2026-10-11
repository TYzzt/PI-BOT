package dev.pibot.android.face

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin

/** Mulberry32, bit-for-bit identical to `rng` in `packages/bot-face/src/engine.ts`. */
class Mulberry32(seed: Int) {
    private var a = seed

    fun next(): Double {
        a += 0x6D2B79F5
        var t = a
        t = (t xor (t ushr 15)) * (t or 1)
        t = t xor (t + (t xor (t ushr 7)) * (t or 61))
        return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
    }
}

class Particle(
    var x: Double,
    var y: Double,
    var vx: Double,
    var vy: Double,
    var rotation: Double,
    val spin: Double,
    var life: Double,
    val maxLife: Double,
    val color: Int,
)

data class Frame(
    val t: Double,
    val mood: String,
    /** 0 = open, 1 = fully closed. */
    val blink: Double,
    val gazeX: Double,
    val gazeY: Double,
    val scaleX: Double,
    val scaleY: Double,
    val offsetY: Double,
    val rotation: Double,
    val particles: List<Particle>,
)

private const val BLINK_SECONDS = 0.16
private const val MAX_PARTICLES = 80
private val BLINKING_EYES = setOf("open", "focus", "small", "wink")

fun clamp(v: Double, min: Double, max: Double) = if (v < min) min else if (v > max) max else v

/** Line-by-line port of `BotEngine` so both platforms animate identically for the same seed. */
class PiBotEngine(private val spec: PiBotSpec, mood: String = spec.defaults.mood, seed: Int = 1, private val reduceMotion: Boolean = false) {
    private var t = 0.0
    var mood: String = mood
        private set
    private val random = Mulberry32(seed)
    private var nextBlink = 1.5 + random.next() * 2
    private var blinkPhase = -1.0
    private var gazeX = 0.0
    private var gazeY = 0.0
    private var gazeVx = 0.0
    private var gazeVy = 0.0
    private var pointer: Pair<Double, Double>? = null
    private var hopY = 0.0
    private var hopV = 0.0
    private var spinLeft = 0.0
    private var angle = 0.0
    private var particles = ArrayList<Particle>()
    private var spawnDebt = 0.0

    fun setMood(next: String) {
        if (next == mood) return
        mood = next
        if (next == "celebrate") {
            bounce()
            burst()
        } else if (next == "happy") bounce()
    }

    /** Pointer in unit space (-1..1); null re-centers the eyes. */
    fun look(x: Double?, y: Double?) {
        pointer = if (x == null || y == null) null else clamp(x, -1.0, 1.0) to clamp(y, -1.0, 1.0)
    }

    fun bounce() {
        if (!reduceMotion) hopV = -2.4
    }

    fun spin(turns: Double = 1.0) {
        if (!reduceMotion && spinLeft <= 0) spinLeft = turns
    }

    fun burst(count: Int = 26) {
        if (reduceMotion) return
        repeat(count) { spawn(true) }
    }

    private fun spawn(burst: Boolean) {
        if (particles.size >= MAX_PARTICLES) return
        val r = random
        val angle = if (burst) -PI / 2 + (r.next() - 0.5) * PI * 1.4 else 0.0
        val speed = if (burst) 1.6 + r.next() * 1.6 else 0.0
        val maxLife = 1.2 + r.next() * 1.2
        val x = if (burst) (r.next() - 0.5) * 0.4 else (r.next() - 0.5) * 2.4
        val y = if (burst) -0.4 else -1.25
        val vx = if (burst) cos(angle) * speed else (r.next() - 0.5) * 0.3
        val vy = if (burst) sin(angle) * speed else 0.3 + r.next() * 0.4
        val rotation = r.next() * PI * 2
        val spin = (r.next() - 0.5) * 10
        val color = floor(r.next() * spec.confetti.size).toInt()
        particles.add(Particle(x, y, vx, vy, rotation, spin, maxLife, maxLife, color))
    }

    fun step(delta: Double) {
        val dt = clamp(delta, 0.0, 0.1)
        t += dt
        val style = spec.mood(mood)
        if (!reduceMotion && style.eyes in BLINKING_EYES) {
            nextBlink -= dt
            if (nextBlink <= 0 && blinkPhase < 0) {
                blinkPhase = 0.0
                nextBlink = 2.4 + random.next() * 3.2
            }
        }
        if (blinkPhase >= 0) {
            blinkPhase += dt / BLINK_SECONDS
            if (blinkPhase > 1) blinkPhase = -1.0
        }
        val (tx, ty) = gazeTarget()
        val k = 60.0
        val d = 12.0
        gazeVx += ((tx - gazeX) * k - gazeVx * d) * dt
        gazeVy += ((ty - gazeY) * k - gazeVy * d) * dt
        gazeX += gazeVx * dt
        gazeY += gazeVy * dt
        hopV += (-hopY * 220 - hopV * 14) * dt
        hopY += hopV * dt
        if (spinLeft > 0) {
            val turn = dt * 1.6
            spinLeft -= turn
            angle += turn * PI * 2
            if (spinLeft <= 0) angle = 0.0
        }
        if (style.effect == "confetti" && !reduceMotion) {
            spawnDebt += dt * 14
            while (spawnDebt >= 1) {
                spawn(false)
                spawnDebt--
            }
        }
        for (p in particles) {
            p.vy += 2.2 * dt
            p.vx *= 1 - 0.6 * dt
            p.x += p.vx * dt
            p.y += p.vy * dt
            p.rotation += p.spin * dt
            p.life -= dt
        }
        particles = particles.filterTo(ArrayList()) { it.life > 0 && it.y < 1.6 }
    }

    private fun gazeTarget(): Pair<Double, Double> = when {
        mood == "searching" -> sin(t * 2.4) * 0.9 to 0.1
        mood == "thinking" -> 0.55 to -0.65
        mood == "working" -> 0.0 to 0.45
        mood == "sleeping" -> 0.0 to 0.0
        pointer != null -> pointer!!
        reduceMotion -> 0.0 to 0.0
        else -> sin(t * 0.37) * 0.18 to sin(t * 0.23) * 0.08
    }

    fun frame(): Frame {
        val motion = if (reduceMotion) 0.0 else 1.0
        val breathe = sin((t * PI * 2) / (if (mood == "sleeping") 4 else 3))
        val amp = if (mood == "sleeping") 0.035 else 0.02
        var offsetY = hopY * 0.12
        offsetY += when (mood) {
            "celebrate" -> -abs(sin(t * 5.5)) * 0.07 * motion
            "working" -> sin(t * 18) * 0.008 * motion
            else -> sin(t * 2) * 0.012 * motion
        }
        val stretch = clamp(-hopV * 0.04, -0.08, 0.1)
        return Frame(
            t = t,
            mood = mood,
            blink = if (blinkPhase < 0) 0.0 else sin(PI * blinkPhase),
            gazeX = clamp(gazeX, -1.0, 1.0),
            gazeY = clamp(gazeY, -1.0, 1.0),
            scaleX = 1 + (breathe * amp - stretch * 0.6) * motion,
            scaleY = 1 + (-breathe * amp + stretch) * motion,
            offsetY = offsetY,
            rotation = angle,
            particles = particles.toList(),
        )
    }
}
