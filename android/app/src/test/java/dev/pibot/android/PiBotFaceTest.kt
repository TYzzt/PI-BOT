package dev.pibot.android

import dev.pibot.android.face.Avatar
import dev.pibot.android.face.COLORS
import dev.pibot.android.face.MOODS
import dev.pibot.android.face.Mulberry32
import dev.pibot.android.face.PiBotEngine
import dev.pibot.android.face.PiBotSpec
import dev.pibot.android.face.SHAPES
import dev.pibot.android.face.avatarFor
import dev.pibot.android.face.moodFor
import dev.pibot.android.face.sleepLabel
import dev.pibot.android.face.smoothOutline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Reference values come from the TypeScript implementation in `packages/bot-face`. */
class PiBotFaceTest {
    private val spec = PiBotSpec.parse(File(System.getProperty("botFaceSpec") ?: "../../packages/bot-face/spec.json").readText())
    private val eps = 1e-9

    @Test
    fun specMatchesTheSharedLists() {
        assertEquals(1, spec.version)
        assertEquals(SHAPES, spec.shapes.keys.toList())
        assertEquals(COLORS, spec.colors.keys.toList())
        assertEquals(MOODS, spec.moods.keys.toList())
        for (shape in spec.shapes.values) assertTrue(shape.points.size >= 8 && shape.points.all { it.size == 2 })
        for (color in spec.colors.values) assertTrue(color.light.size == 2 && color.dark.size == 2)
        assertTrue(spec.confetti.isNotEmpty())
    }

    @Test
    fun mulberry32MatchesTypeScript() {
        val r = Mulberry32(42)
        val expected = listOf(0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423)
        for (value in expected) assertEquals(value, r.next(), 0.0)
        val negative = Mulberry32(-7)
        assertEquals(0.43306733411736786, negative.next(), 0.0)
        assertEquals(0.32539576734416187, negative.next(), 0.0)
    }

    @Test
    fun avatarForMatchesTypeScript() {
        assertEquals(Avatar("pebble", "cocoa", "light"), avatarFor("00000000-0000-0000-0000-000000000000"))
        assertEquals(Avatar("egg", "sky", "light"), avatarFor("3f2b6c1e-9a4d-4e8b-b1a2-7c9d0e1f2a3b"))
        assertEquals(Avatar("squircle", "sky", "light"), avatarFor("研究助理"))
        assertEquals(Avatar("blob", "orange", "light"), Avatar("triangle", "neon", "sepia").normalized())
    }

    @Test
    fun outlineMatchesTypeScript() {
        val o = smoothOutline(spec.shape("blob").points)
        assertEquals(12, o.segments.size)
        val first = o.segments[0]
        assertEquals(0.15, first.c1.x, eps); assertEquals(-0.85, first.c1.y, eps)
        assertEquals(0.33, first.c2.x, eps); assertEquals(-0.8283333333333334, first.c2.y, eps)
        assertEquals(0.45, first.end.x, eps); assertEquals(-0.75, first.end.y, eps)
        val last = o.segments[11]
        assertEquals(-0.33, last.c1.x, eps); assertEquals(0.0, last.end.x, eps); assertEquals(-0.85, last.end.y, eps)
    }

    @Test
    fun engineFramesMatchTypeScript() {
        val e = PiBotEngine(spec, "idle", seed = 7)
        repeat(30) { e.step(1.0 / 60) }
        e.setMood("celebrate")
        repeat(90) { e.step(1.0 / 60) }
        val f = e.frame()
        assertEquals(1.9999999999999978, f.t, eps)
        assertEquals(0.0, f.blink, eps)
        assertEquals(0.11200371216902492, f.gazeX, eps)
        assertEquals(0.03245360515907288, f.gazeY, eps)
        assertEquals(0.9826797127457848, f.scaleX, eps)
        assertEquals(1.0173201400398995, f.scaleY, eps)
        assertEquals(-0.06999943162719986, f.offsetY, eps)
        assertEquals(32, f.particles.size)
        val p = f.particles[0]
        assertEquals(0.49412557905386495, p.x, eps)
        assertEquals(-1.9354102182212343, p.y, eps)
        assertEquals(5.076956534321522, p.rotation, eps)
        assertEquals(1.5093786732293664, p.maxLife, eps)
        assertEquals(1, p.color)

        val look = PiBotEngine(spec, "idle", seed = 3)
        look.look(2.0, -0.5)
        repeat(120) { look.step(1.0 / 60) }
        assertEquals(1.0, look.frame().gazeX, eps)
        assertEquals(-0.5000007718850202, look.frame().gazeY, eps)
    }

    @Test
    fun reduceMotionKeepsTheBotStill() {
        val e = PiBotEngine(spec, "idle", seed = 1, reduceMotion = true)
        e.setMood("celebrate")
        repeat(60) { e.step(1.0 / 60) }
        val f = e.frame()
        assertTrue(f.particles.isEmpty())
        assertEquals(1.0, f.scaleX, eps)
        assertEquals(0.0, f.offsetY, eps)
    }

    @Test
    fun moodMappingMatchesTypeScript() {
        val now = 10_000_000_000L
        assertEquals("thinking", moodFor("queued", now = now))
        assertEquals("thinking", moodFor("running", now = now))
        assertEquals("searching", moodFor("running", tool = "web_search", now = now))
        assertEquals("working", moodFor("running", tool = "run_command", now = now))
        assertEquals("waiting", moodFor("waiting_approval", now = now))
        assertEquals("celebrate", moodFor("completed", finishedAt = now - 1_000, now = now))
        assertEquals("idle", moodFor("completed", finishedAt = now - 60_000, lastActiveAt = now - 60_000, now = now))
        assertEquals("error", moodFor("failed", finishedAt = now - 1_000, now = now))
        assertEquals("sleeping", moodFor("completed", finishedAt = now - 8 * 86_400_000L, lastActiveAt = now - 7 * 86_400_000L - 1, now = now))
        assertEquals("7 天", sleepLabel(now - 7 * 86_400_000L - 5, now))
        assertNull(sleepLabel(now - 3_600_000L, now))
    }
}
