package dev.pibot.android.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class UiViewportTest {
    @Test fun onlyUnconsumedMotionReachesTheChatAtEitherEdge() {
        assertEquals(70, uiScrollTarget(50, 20, 100))
        assertEquals(30, 80 - (uiScrollTarget(50, 80, 100) - 50))
        assertEquals(-30, -80 - (uiScrollTarget(50, -80, 100) - 50))
        assertEquals(40, 40 - uiScrollTarget(0, 40, 0))
    }
    @Test fun shortAndLongContentUseTheAvailableChatHeight() {
        assertEquals(100f, uiDisplayHeight(0f, 800f))
        assertEquals(599f, uiDisplayHeight(599f, 800f))
        assertEquals(600f, uiDisplayHeight(600f, 800f))
        assertEquals(600f, uiDisplayHeight(601f, 800f))
        assertEquals(600f, uiDisplayHeight(16000f, 800f))
        assertEquals(300f, uiDisplayHeight(16000f, 400f))
        assertEquals(6000f, uiDisplayHeight(16000f, 10000f))
    }
}
