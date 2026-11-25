package dev.pibot.android.ui

/** Native dp/pt after converting from the page's CSS viewport width. */
internal fun uiDisplayHeight(contentHeight: Float, viewportHeight: Float): Float {
    val limit = (viewportHeight * .75f).coerceIn(100f, 6000f)
    return contentHeight.coerceIn(100f, limit)
}

internal fun uiScrollTarget(position: Int, delta: Int, maximum: Int): Int =
    (position.toLong() + delta).coerceIn(0L, maximum.coerceAtLeast(0).toLong()).toInt()
