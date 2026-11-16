import test from "node:test";
import assert from "node:assert/strict";
import { processDocument } from "../src/documents/runtime.js";
import { documentTools } from "../src/documents/tools.js";
import JSZip from "jszip";
import ExcelJS from "exceljs";
function pdf(text: string) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let value = "%PDF-1.4\n",
    offsets = [0];
  for (const [index, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const start = Buffer.byteLength(value);
  value +=
    `xref\n0 6\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(value);
}
test("document workers roundtrip Chinese Word paragraphs, tables and replacement copies", async () => {
  const result = await processDocument({
    action: "write",
    name: "周报.docx",
    content: {
      paragraphs: [
        { text: "研发周报", heading: 1 },
        { text: "本周已完成文档接入" },
      ],
      tables: [
        [
          ["项目", "进度"],
          ["PiBot", "完成"],
        ],
      ],
    },
  });
  assert.ok(result.bytes.length > 0);
  const read = await processDocument(
    { action: "read", name: "周报.docx" },
    result.bytes,
  );
  assert.match(JSON.stringify(read), /研发周报/);
  assert.match(JSON.stringify(read), /<table>/);
  const edited = await processDocument(
    {
      action: "edit",
      name: "周报副本.docx",
      replacements: [
        { old_text: "本周已完成文档接入", new_text: "本周已完成文档验证" },
      ],
    },
    result.bytes,
  );
  assert.ok(edited.warnings.length);
  assert.match(
    JSON.stringify(
      await processDocument(
        { action: "read", name: "副本.docx" },
        edited.bytes,
      ),
    ),
    /文档验证/,
  );
  assert.match(
    JSON.stringify(
      await processDocument(
        { action: "read", name: "原件.docx" },
        result.bytes,
      ),
    ),
    /文档接入/,
  );
  await assert.rejects(
    processDocument(
      {
        action: "edit",
        name: "副本.docx",
        replacements: [{ old_text: "不存在", new_text: "x" }],
      },
      result.bytes,
    ),
    /不存在或不唯一/,
  );
});
test("Excel preserves cached formulas, marks uncalculated formulas and edits named sheets", async () => {
  const result = await processDocument({
    action: "write",
    name: "数据.xlsx",
    content: {
      sheets: [
        {
          name: "销量",
          rows: [
            ["项目", "数量"],
            ["甲", 2],
            ["乙", { formula: "B2*2", result: 4 }],
            ["丙", { formula: "B2*3" }],
          ],
        },
        { name: "备注", rows: [["中文说明"]] },
      ],
    },
  });
  const read = await processDocument(
    { action: "read", name: "数据.xlsx", sheet: "销量" },
    result.bytes,
  );
  assert.equal(read.sheets.length, 2);
  assert.equal(read.rows[2].values[1].result, 4);
  assert.equal(read.rows[3].values[1].result, "未计算");
  const edited = await processDocument(
    {
      action: "edit",
      name: "副本.xlsx",
      cells: [{ sheet: "销量", cell: "B2", value: 9 }],
    },
    result.bytes,
  );
  assert.equal(
    (await processDocument({ action: "read", name: "副本.xlsx" }, edited.bytes))
      .rows[1].values[1],
    9,
  );
});
test("PDF extracts text, reports empty pages and honors page offsets", async () => {
  const read = await processDocument(
    { action: "read", name: "read.pdf", limit: 1 },
    pdf("Hello PiBot"),
  );
  assert.match(read.pages[0].text, /Hello PiBot/);
  assert.equal(read.has_more, false);
  const empty = await processDocument(
    { action: "read", name: "scan.pdf" },
    pdf(""),
  );
  assert.match(empty.pages[0].warning, /OCR/);
  assert.deepEqual(
    (
      await processDocument(
        { action: "read", name: "read.pdf", offset: 1 },
        pdf("one"),
      )
    ).pages,
    [],
  );
});
test("format validation, macros, cancellation and readonly tool registration", async () => {
  await assert.rejects(
    processDocument(
      { action: "inspect", name: "fake.pdf" },
      Buffer.from("not a pdf"),
    ),
    /格式/,
  );
  await assert.rejects(
    processDocument({ action: "inspect", name: "old.doc" }, Buffer.from("old")),
    /仅支持/,
  );
  const zip = new JSZip();
  zip.file("word/document.xml", "<xml/>");
  zip.file("word/vbaProject.bin", "macro");
  await assert.rejects(
    processDocument(
      { action: "inspect", name: "macro.docx" },
      await zip.generateAsync({ type: "nodebuffer" }),
    ),
    /宏/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    processDocument(
      { action: "read", name: "read.pdf" },
      pdf("hello"),
      aborted.signal,
    ),
    /取消/,
  );
  assert.deepEqual(
    documentTools("http://localhost", () => "", "run", false).map(
      (t) => t.name,
    ),
    ["document_read"],
  );
  assert.equal(
    documentTools("http://localhost", () => "", "run", true).length,
    4,
  );
});

test("publish accepts a PDF generated by other tools and cloud library paths", async (t) => {
  const bytes = pdf("Generated by an environment tool");
  const requests: { path: string; body: any }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(options.body as string);
      requests.push({ path, body });
      return Response.json({ artifact: { id: "generated-pdf" } });
    },
  );
  const local = documentTools("http://localhost", () => "token", "run", true, {
    read: async (path) => {
      assert.equal(path, "documents/generated.pdf");
      return bytes;
    },
    write: async () => {
      assert.fail("publishing must not regenerate a file");
    },
  }).find((tool) => tool.name === "document_publish")!;
  await local.execute(
    "publish-local",
    { path: "documents/generated.pdf" },
    undefined,
    undefined,
    {} as any,
  );
  assert.equal(requests[0].path, "/agent/documents/save");
  assert.equal(requests[0].body.name, "generated.pdf");
  assert.deepEqual(Buffer.from(requests[0].body.data, "base64"), bytes);
  assert.equal(requests[1].body.artifact_id, "generated-pdf");
  const cloud = documentTools(
    "http://localhost",
    () => "token",
    "run",
    true,
  ).find((tool) => tool.name === "document_publish")!;
  await cloud.execute(
    "publish-cloud",
    { path: "documents/generated.pdf" },
    undefined,
    undefined,
    {} as any,
  );
  assert.equal(requests[2].path, "/agent/documents/publish");
  assert.equal(requests[2].body.path, "documents/generated.pdf");
});

test("large document reads resume by item and JSON fragment without losing content", async () => {
  const word = await processDocument({
    action: "write",
    name: "long.docx",
    content: {
      paragraphs: [0, 1, 2].map((n) => ({
        text: `${n}:` + "文".repeat(30000),
      })),
    },
  });
  const first = await processDocument(
    { action: "read", name: "long.docx", limit: 100 },
    word.bytes,
  );
  assert.equal(first.blocks.length, 1);
  assert.equal(first.next_offset, 1);
  assert.equal(first.has_more, true);
  const second = await processDocument(
    { action: "read", name: "long.docx", offset: first.next_offset },
    word.bytes,
  );
  assert.match(second.blocks[0], /1:文/);
  const values = Array.from(
    { length: 4 },
    (_, n) => `${n}:` + "数".repeat(15000),
  );
  const excel = await processDocument({
    action: "write",
    name: "wide.xlsx",
    content: {
      sheets: [{ name: "数据", rows: [values] }],
    },
  });
  const a = await processDocument(
    { action: "read", name: "wide.xlsx" },
    excel.bytes,
  );
  assert.equal(a.next_offset, 0);
  assert.equal(a.next_fragment, 1);
  assert.ok(a.content_fragment.length <= 48000);
  const b = await processDocument(
    {
      action: "read",
      name: "wide.xlsx",
      offset: a.next_offset,
      fragment: a.next_fragment,
    },
    excel.bytes,
  );
  assert.equal(b.next_offset, 1);
  assert.equal(b.has_more, false);
  assert.deepEqual(
    JSON.parse(a.content_fragment + b.content_fragment).values,
    values,
  );
});

test("Excel reads every uploaded column and resumes oversized rows through JSON fragments", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("宽表");
  const values = Array.from({ length: 300 }, (_, n) => `第${n + 1}列：` + "数".repeat(200));
  sheet.addRow(values);
  sheet.getCell("XFD2").value = "Excel 最后一列";
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  let fragment = 0, encoded = "";
  for (;;) {
    const read = await processDocument({ action: "read", name: "宽表.xlsx", fragment }, bytes);
    assert.equal(read.rows.length, 0);
    encoded += read.content_fragment;
    if (read.next_fragment === undefined) {
      assert.equal(read.next_offset, 1);
      assert.equal(read.has_more, true);
      break;
    }
    assert.equal(read.next_offset, 0);
    fragment = read.next_fragment;
  }
  assert.deepEqual(JSON.parse(encoded).values, values);
  encoded = "";
  fragment = 0;
  for (;;) {
    const read = await processDocument({ action: "read", name: "宽表.xlsx", offset: 1, fragment }, bytes);
    encoded += read.content_fragment;
    if (read.next_fragment === undefined) {
      assert.equal(read.has_more, false);
      assert.equal(read.next_offset, 2);
      break;
    }
    fragment = read.next_fragment;
  }
  assert.equal(JSON.parse(encoded).values[16383], "Excel 最后一列");
});
