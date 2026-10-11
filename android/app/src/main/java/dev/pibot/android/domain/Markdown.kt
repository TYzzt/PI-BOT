package dev.pibot.android.domain

/** A deliberately small Markdown subset for bot replies: headings, lists, quotes, code fences, tables and inline marks. */
sealed interface Block {
    data class Heading(val level: Int, val text: String) : Block
    data class Paragraph(val text: String) : Block
    data class Bullet(val marker: String, val text: String, val depth: Int) : Block
    data class Quote(val text: String) : Block
    data class Code(val text: String) : Block
    data class Table(val rows: List<List<String>>) : Block
    data object Rule : Block
}

data class Span(val text: String, val bold: Boolean = false, val italic: Boolean = false, val code: Boolean = false)

private val HEADING = Regex("^(#{1,6})\\s+(.*)$")
private val BULLET = Regex("^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$")
private val TABLE_DIVIDER = Regex("^\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?$")

fun parseMarkdown(source: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val lines = source.replace("\r\n", "\n").split('\n')
    var i = 0
    val paragraph = mutableListOf<String>()
    fun flush() {
        if (paragraph.isNotEmpty()) blocks += Block.Paragraph(paragraph.joinToString("\n"))
        paragraph.clear()
    }
    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trim()
        when {
            trimmed.startsWith("```") -> {
                flush()
                val code = mutableListOf<String>()
                i++
                while (i < lines.size && !lines[i].trim().startsWith("```")) code += lines[i++]
                blocks += Block.Code(code.joinToString("\n"))
            }
            trimmed.isEmpty() -> flush()
            trimmed == "---" || trimmed == "***" -> { flush(); blocks += Block.Rule }
            HEADING.matches(trimmed) -> {
                flush()
                val m = HEADING.find(trimmed)!!
                blocks += Block.Heading(m.groupValues[1].length, m.groupValues[2])
            }
            trimmed.startsWith("|") && i + 1 < lines.size && TABLE_DIVIDER.matches(lines[i + 1].trim()) -> {
                flush()
                val rows = mutableListOf(cells(trimmed))
                i += 2
                while (i < lines.size && lines[i].trim().startsWith("|")) rows += cells(lines[i++].trim())
                blocks += Block.Table(rows)
                continue
            }
            BULLET.matches(line) -> {
                flush()
                val m = BULLET.find(line)!!
                val marker = m.groupValues[2].let { if (it[0].isDigit()) it else "•" }
                blocks += Block.Bullet(marker, m.groupValues[3], m.groupValues[1].length / 2)
            }
            trimmed.startsWith(">") -> { flush(); blocks += Block.Quote(trimmed.removePrefix(">").trim()) }
            else -> paragraph += line
        }
        i++
    }
    flush()
    return blocks
}

private fun cells(row: String) = row.trim('|').split('|').map { it.trim() }

/** Inline `**bold**`, `*italic*` / `_italic_` and `` `code` ``; unmatched markers stay literal. */
fun parseInline(text: String): List<Span> {
    val spans = mutableListOf<Span>()
    val plain = StringBuilder()
    fun flush() {
        if (plain.isNotEmpty()) spans += Span(plain.toString())
        plain.clear()
    }
    var i = 0
    while (i < text.length) {
        val rest = text.substring(i)
        val match = when {
            rest.startsWith("`") -> rest.indexOf('`', 1).takeIf { it > 1 }?.let { Span(rest.substring(1, it), code = true) to it + 1 }
            rest.startsWith("**") -> rest.indexOf("**", 2).takeIf { it > 2 }?.let { Span(rest.substring(2, it), bold = true) to it + 2 }
            rest.startsWith("*") || rest.startsWith("_") -> {
                val mark = rest[0]
                rest.indexOf(mark, 1).takeIf { it > 1 && !rest[1].isWhitespace() }?.let { Span(rest.substring(1, it), italic = true) to it + 1 }
            }
            else -> null
        }
        if (match != null) {
            flush()
            spans += match.first
            i += match.second
        } else {
            plain.append(text[i++])
        }
    }
    flush()
    return spans
}
