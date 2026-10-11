package dev.pibot.android.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

val Accent = Color(0xFFF4692A)
val AccentSoft = Color(0xFFFFEFE4)
val Paper = Color(0xFFF6F4F1)
val Card = Color(0xFFFFFFFF)
val Ink = Color(0xFF1F1F23)
val Muted = Color(0xFF8A877F)
val Line = Color(0xFFE7E3DC)
val Good = Color(0xFF2FA36B)
val Danger = Color(0xFFD9483B)

private val colors = lightColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    primaryContainer = AccentSoft,
    onPrimaryContainer = Color(0xFF7A2E0B),
    secondary = Ink,
    onSecondary = Color.White,
    background = Paper,
    onBackground = Ink,
    surface = Paper,
    onSurface = Ink,
    surfaceVariant = Color(0xFFEFEBE5),
    onSurfaceVariant = Muted,
    surfaceContainer = Card,
    surfaceContainerLow = Card,
    surfaceContainerHigh = Card,
    surfaceContainerHighest = Color(0xFFEFEBE5),
    outline = Line,
    outlineVariant = Line,
    error = Danger,
)

@Composable
fun PiBotTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = colors,
        shapes = Shapes(small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(16.dp), large = RoundedCornerShape(22.dp)),
        content = content,
    )
}
