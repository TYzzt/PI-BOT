package dev.pibot.android.ui

import android.content.Context
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.webkit.WebView
import android.widget.OverScroller
import androidx.core.view.NestedScrollingChild3
import androidx.core.view.NestedScrollingChildHelper
import androidx.core.view.ViewCompat
import kotlin.math.abs

/** DOM handles horizontal table gestures; native vertical deltas flow into the chat at an edge. */
internal class UiScrollWebView(context: Context) : WebView(context), NestedScrollingChild3 {
    private var nestedHelper: NestedScrollingChildHelper? = null
    private val nested: NestedScrollingChildHelper
        get() = nestedHelper ?: NestedScrollingChildHelper(this).also { nestedHelper = it }
    private val scroller = OverScroller(context)
    private val config = ViewConfiguration.get(context)
    private var tracker: VelocityTracker? = null
    private var startX = 0f
    private var startY = 0f
    private var lastY = 0f
    private var flingY = 0
    private var axis = 0
    private var gesture = 0
    private var canHandoff = false
    var verticalScrollingEnabled = false

    init { isNestedScrollingEnabled = true }

    private fun step(delta: Int, type: Int): Boolean {
        val before = scrollY
        val maximum = if (verticalScrollingEnabled) (computeVerticalScrollRange() - height).coerceAtLeast(0) else 0
        scrollTo(0, uiScrollTarget(before, delta, maximum))
        val consumed = scrollY - before
        val parentConsumed = IntArray(2)
        dispatchNestedScroll(0, consumed, 0, delta - consumed, null, type, parentConsumed)
        return consumed != 0 || parentConsumed[1] != 0
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                scroller.abortAnimation()
                stopNestedScroll(ViewCompat.TYPE_NON_TOUCH)
                startNestedScroll(ViewCompat.SCROLL_AXIS_VERTICAL, ViewCompat.TYPE_TOUCH)
                tracker?.recycle()
                tracker = VelocityTracker.obtain()
                startX = event.rawX; startY = event.rawY; lastY = event.rawY; axis = 0
                canHandoff = false
                val current = ++gesture
                // Fail closed while the asynchronous DOM hit test is pending. Never steal a
                // control/map gesture, a long press selection, or a multi-finger gesture.
                if (width > 0 && height > 0) evaluateJavascript(
                    "window.piBotUi?.canScrollAt(${event.x / width},${event.y / height}) === true"
                ) { result -> if (gesture == current && axis == 0) canHandoff = result == "true" }
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> {
                if (axis == 0 && maxOf(abs(event.rawX - startX), abs(event.rawY - startY)) > config.scaledTouchSlop) {
                    axis = if (abs(event.rawX - startX) > abs(event.rawY - startY) || !canHandoff ||
                        event.eventTime - event.downTime >= ViewConfiguration.getLongPressTimeout()) 1 else 2
                    if (axis == 2) {
                        val cancel = MotionEvent.obtain(event)
                        cancel.action = MotionEvent.ACTION_CANCEL
                        super.onTouchEvent(cancel)
                        cancel.recycle()
                    }
                }
                if (axis == 2) {
                    tracker?.addMovement(event)
                    step((lastY - event.rawY).toInt(), ViewCompat.TYPE_TOUCH)
                    lastY = event.rawY
                    return true
                }
                lastY = event.rawY
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                canHandoff = false
                if (axis != 2) axis = 1
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                gesture++
                val vertical = axis == 2
                if (vertical && event.actionMasked == MotionEvent.ACTION_UP) {
                    tracker?.addMovement(event)
                    tracker?.computeCurrentVelocity(1000, config.scaledMaximumFlingVelocity.toFloat())
                    val velocity = -(tracker?.yVelocity ?: 0f).toInt()
                    if (abs(velocity) >= config.scaledMinimumFlingVelocity) {
                        startNestedScroll(ViewCompat.SCROLL_AXIS_VERTICAL, ViewCompat.TYPE_NON_TOUCH)
                        flingY = 0
                        scroller.fling(0, 0, 0, velocity, 0, 0, Int.MIN_VALUE, Int.MAX_VALUE)
                        postInvalidateOnAnimation()
                    }
                }
                tracker?.recycle(); tracker = null
                stopNestedScroll(ViewCompat.TYPE_TOUCH)
                parent?.requestDisallowInterceptTouchEvent(false)
                if (vertical) return true
            }
        }
        tracker?.addMovement(event)
        return super.onTouchEvent(event)
    }

    override fun computeScroll() {
        super.computeScroll()
        if (scroller.computeScrollOffset()) {
            val current = scroller.currY
            if (!step(current - flingY, ViewCompat.TYPE_NON_TOUCH)) scroller.abortAnimation()
            flingY = current
            postInvalidateOnAnimation()
        } else stopNestedScroll(ViewCompat.TYPE_NON_TOUCH)
    }

    override fun onDetachedFromWindow() {
        gesture++
        scroller.abortAnimation(); tracker?.recycle(); tracker = null
        stopNestedScroll(ViewCompat.TYPE_TOUCH); stopNestedScroll(ViewCompat.TYPE_NON_TOUCH)
        super.onDetachedFromWindow()
    }

    override fun setNestedScrollingEnabled(enabled: Boolean) { nested.isNestedScrollingEnabled = enabled }
    override fun isNestedScrollingEnabled() = nested.isNestedScrollingEnabled
    override fun startNestedScroll(axes: Int) = nested.startNestedScroll(axes)
    override fun startNestedScroll(axes: Int, type: Int) = nested.startNestedScroll(axes, type)
    override fun stopNestedScroll() = nested.stopNestedScroll()
    override fun stopNestedScroll(type: Int) = nested.stopNestedScroll(type)
    override fun hasNestedScrollingParent() = nested.hasNestedScrollingParent()
    override fun hasNestedScrollingParent(type: Int) = nested.hasNestedScrollingParent(type)
    override fun dispatchNestedPreScroll(dx: Int, dy: Int, consumed: IntArray?, offset: IntArray?) = nested.dispatchNestedPreScroll(dx, dy, consumed, offset)
    override fun dispatchNestedPreScroll(dx: Int, dy: Int, consumed: IntArray?, offset: IntArray?, type: Int) = nested.dispatchNestedPreScroll(dx, dy, consumed, offset, type)
    override fun dispatchNestedScroll(dx: Int, dy: Int, ux: Int, uy: Int, offset: IntArray?) = nested.dispatchNestedScroll(dx, dy, ux, uy, offset)
    override fun dispatchNestedScroll(dx: Int, dy: Int, ux: Int, uy: Int, offset: IntArray?, type: Int) = nested.dispatchNestedScroll(dx, dy, ux, uy, offset, type)
    override fun dispatchNestedScroll(dx: Int, dy: Int, ux: Int, uy: Int, offset: IntArray?, type: Int, consumed: IntArray) = nested.dispatchNestedScroll(dx, dy, ux, uy, offset, type, consumed)
    override fun dispatchNestedPreFling(vx: Float, vy: Float) = nested.dispatchNestedPreFling(vx, vy)
    override fun dispatchNestedFling(vx: Float, vy: Float, consumed: Boolean) = nested.dispatchNestedFling(vx, vy, consumed)
}
