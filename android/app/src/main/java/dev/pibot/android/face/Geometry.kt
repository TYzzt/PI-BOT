package dev.pibot.android.face

data class Pt(val x: Double, val y: Double)
data class Segment(val c1: Pt, val c2: Pt, val end: Pt)
data class Bezier(val start: Pt, val segments: List<Segment>)

/** Closed Catmull-Rom spline through the anchors as cubic Bezier segments; same math as `smoothOutline` in TS. */
fun smoothOutline(points: List<List<Double>>, tension: Double = 1.0): Bezier {
    val n = points.size
    val p = points.map { Pt(it[0], it[1]) }
    val segments = (0 until n).map { i ->
        val p0 = p[(i - 1 + n) % n]
        val p1 = p[i]
        val p2 = p[(i + 1) % n]
        val p3 = p[(i + 2) % n]
        Segment(
            Pt(p1.x + (p2.x - p0.x) / 6 * tension, p1.y + (p2.y - p0.y) / 6 * tension),
            Pt(p2.x - (p3.x - p1.x) / 6 * tension, p2.y - (p3.y - p1.y) / 6 * tension),
            p2,
        )
    }
    return Bezier(p[0], segments)
}

/** Arm direction in radians for an arm style; mirrors `armAngle` in TS. */
fun armAngle(style: String, side: Int, t: Double): Double = when (style) {
    "wave" -> if (side > 0) 2.4 + kotlin.math.sin(t * 9) * 0.35 else 0.4
    "up" -> 2.5 + kotlin.math.sin(t * 7 + side) * 0.2
    "type" -> 0.95 + kotlin.math.sin(t * 16 + (if (side > 0) 0.0 else Math.PI)) * 0.15
    "think" -> if (side > 0) 2.1 else 0.35
    else -> 0.35 + kotlin.math.sin(t * 2 + side) * 0.05
}
