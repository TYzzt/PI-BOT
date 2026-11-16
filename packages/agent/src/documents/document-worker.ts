import { documentJob, documentFormat, DOCUMENT_LIMIT } from "./spec.js";
import { createRequire } from "node:module";
// Use the same locked ZIP implementation used by docx, without extracting paths to disk.
const require = createRequire(import.meta.url);
const JSZip = require("jszip") as typeof import("jszip");
// Bound model context without silently dropping the end of a page, table, or row.
function readWindow(offset: number, fragment: number, total: number) {
  const budget = 48000;
  const items: unknown[] = [];
  let size = 0,
    next = Math.min(offset, total);
  let contentFragment: string | undefined, nextFragment: number | undefined;
  return {
    take(value: unknown) {
      const encoded = JSON.stringify(value);
      if (items.length && size + encoded.length > budget) return false;
      if (!items.length && (encoded.length > budget || fragment)) {
        if (fragment * budget >= encoded.length)
          throw new Error("片段偏移超出范围");
        contentFragment = encoded.slice(
          fragment * budget,
          (fragment + 1) * budget,
        );
        if ((fragment + 1) * budget < encoded.length)
          nextFragment = fragment + 1;
        else next++;
        return false;
      }
      items.push(value);
      size += encoded.length;
      next++;
      return true;
    },
    result(key: string) {
      return {
        [key]: items,
        total,
        has_more: next < total,
        next_offset: next,
        ...(contentFragment === undefined
          ? {}
          : {
              content_fragment: contentFragment,
              fragment_encoding: "json",
              next_fragment: nextFragment,
            }),
      };
    },
  };
}
async function validate(name: string, bytes: Buffer) {
  if (!bytes.length || bytes.length > DOCUMENT_LIMIT)
    throw new Error("文档为空或超过 10 MiB");
  const format = documentFormat(name);
  if (format === "pdf") {
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
      throw new Error("PDF 文件格式不匹配，或文件已加密/损坏");
    return format;
  }
  if (!bytes.subarray(0, 2).equals(Buffer.from("PK")))
    throw new Error("Office 文件格式不匹配，或文件已加密/损坏");
  // Bound declared expanded sizes before inflating XML (ZIP bombs).
  let entries = 0,
    total = 0;
  for (let i = 0; i + 46 < bytes.length; i++)
    if (bytes.readUInt32LE(i) === 0x02014b50) {
      entries++;
      total += bytes.readUInt32LE(i + 24);
      if (entries > 10000 || total > 64 * 1024 * 1024)
        throw new Error("文档解压内容超过限制");
      i +=
        45 +
        bytes.readUInt16LE(i + 28) +
        bytes.readUInt16LE(i + 30) +
        bytes.readUInt16LE(i + 32);
    }
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file(format === "docx" ? "word/document.xml" : "xl/workbook.xml"))
    throw new Error("文件扩展名与内容不匹配");
  if (Object.keys(zip.files).some((p) => /vbaProject\.bin$/i.test(p)))
    throw new Error("不支持包含宏的文档");
  return format;
}
async function execute(raw: unknown, bytes?: Buffer) {
  const job = documentJob.parse(raw),
    format = documentFormat(job.name);
  if (job.action === "inspect") {
    await validate(job.name, bytes!);
    return { format };
  }
  if (job.action === "read" && format === "pdf") {
    await validate(job.name, bytes!);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({
      data: new Uint8Array(bytes!),
      useSystemFonts: false,
    });
    const pdf = await loading.promise;
    try {
      const window = readWindow(job.offset, job.fragment, pdf.numPages);
      for (
        let i = job.offset + 1;
        i <= Math.min(pdf.numPages, job.offset + job.limit);
        i++
      ) {
        const page = await pdf.getPage(i),
          content = await page.getTextContent();
        const text = content.items
          .map((item) =>
            "str" in item
              ? item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ")
              : "",
          )
          .join("");
        const more = window.take({
          page: i,
          text,
          warning: text.trim()
            ? undefined
            : "本页无可提取文字；扫描件暂不支持 OCR",
        });
        page.cleanup();
        if (!more) break;
      }
      return {
        format,
        ...window.result("pages"),
      };
    } finally {
      await loading.destroy();
    }
  }
  if (!["docx", "xlsx"].includes(format))
    throw new Error(
      "当前内置引擎未注册此格式的编写处理器；可核实执行环境中的其他工具和依赖",
    );
  if (bytes) await validate(job.name, bytes);
  if (format === "docx") {
    const mammoth = await import("mammoth");
    if (job.action === "read") {
      const result = await mammoth.convertToHtml({ buffer: bytes! });
      // Return inert HTML as source content, never inject it into the UI.
      const blocks = result.value
        .split(/(?=<(?:p|h[1-6]|table|ul|ol)\b)/)
        .filter(Boolean);
      const window = readWindow(job.offset, job.fragment, blocks.length);
      for (const block of blocks.slice(job.offset, job.offset + job.limit)) {
        if (!window.take(block)) break;
      }
      return {
        format,
        ...window.result("blocks"),
        warnings: result.messages.map((m) => m.message),
      };
    }
    let content = job.content;
    if (job.action === "edit") {
      const extracted = await mammoth.extractRawText({ buffer: bytes! });
      let text = extracted.value;
      if (!job.replacements?.length)
        throw new Error(
          "Word 修改需要 replacements；复杂结构请用 document_write 重建副本",
        );
      for (const r of job.replacements) {
        if (text.split(r.old_text).length !== 2)
          throw new Error("原文不存在或不唯一，请先读取并提供唯一原文");
        text = text.replace(r.old_text, () => r.new_text);
      }
      content = { paragraphs: text.split(/\n\n+/).map((text) => ({ text })) };
    }
    if (!content?.paragraphs?.length && !content?.tables?.length)
      throw new Error("Word 需要 paragraphs 或 tables");
    const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun } =
      await import("docx");
    const children: any[] = (content.paragraphs ?? []).map(
      (p) =>
        new Paragraph({
          children: [new TextRun(p.text)],
          heading: p.heading ? (`Heading${p.heading}` as any) : undefined,
          bullet: p.bullet ? { level: 0 } : undefined,
        }),
    );
    for (const table of content.tables ?? [])
      children.push(
        new Table({
          rows: table.map(
            (row) =>
              new TableRow({
                children: row.map(
                  (text) => new TableCell({ children: [new Paragraph(text)] }),
                ),
              }),
          ),
        }),
      );
    return {
      bytes: await Packer.toBuffer(new Document({ sections: [{ children }] })),
      warnings:
        job.action === "edit"
          ? ["已按内容重新生成副本；原文件的复杂版式、图片及高级功能不保留"]
          : [],
    };
  }
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  if (bytes) await book.xlsx.load(bytes as any);
  if (job.action === "read") {
    const sheet = job.sheet ? book.getWorksheet(job.sheet) : book.worksheets[0];
    if (!sheet) throw new Error("工作表不存在");
    const window = readWindow(job.offset, job.fragment, sheet.rowCount);
    for (
      let n = job.offset + 1;
      n <= Math.min(sheet.rowCount, job.offset + job.limit);
      n++
    ) {
      const row = sheet.getRow(n),
        values = [];
      for (let c = 1; c <= row.cellCount; c++) {
        const value = row.getCell(c).value;
        values.push(
          value && typeof value === "object" && "formula" in value
            ? { ...value, result: value.result ?? "未计算" }
            : value,
        );
      }
      if (!window.take({ row: n, values })) break;
    }
    return {
      format,
      sheets: book.worksheets.map((s) => ({ name: s.name, rows: s.rowCount })),
      sheet: sheet.name,
      ...window.result("rows"),
    };
  }
  if (job.action === "write") {
    if (!job.content?.sheets?.length) throw new Error("Excel 需要 sheets");
    for (const s of job.content.sheets) {
      const sheet = book.addWorksheet(s.name);
      for (const row of s.rows) sheet.addRow(row);
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
    }
  } else {
    if (!job.cells?.length) throw new Error("Excel 修改需要 cells");
    for (const edit of job.cells) {
      const sheet = book.getWorksheet(edit.sheet);
      if (!sheet) throw new Error("工作表不存在");
      sheet.getCell(edit.cell).value = edit.value as any;
    }
  }
  book.calcProperties.fullCalcOnLoad = true;
  return {
    bytes: Buffer.from(await book.xlsx.writeBuffer()),
    warnings: ["公式在 Excel 打开时重算；复杂图表和高级功能不承诺完整保留"],
  };
}
process.once("message", async (message: { job: unknown; bytes?: Buffer }) => {
  try {
    const result = await execute(message.job, message.bytes);
    if (result.bytes && result.bytes.length > DOCUMENT_LIMIT)
      throw new Error("生成文件超过 10 MiB");
    process.send?.({ ok: true, result }, () => process.exit(0));
  } catch (error) {
    process.send?.(
      {
        ok: false,
        error: error instanceof Error ? error.message : "文档处理失败",
      },
      () => process.exit(1),
    );
  }
});
