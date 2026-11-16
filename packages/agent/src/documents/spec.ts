import { z } from "zod";
export const DOCUMENT_LIMIT = 10 * 1024 * 1024;
export const DOCUMENT_CHUNK = 256 * 1024;
export const DOCUMENT_MIMES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;
export function documentFormat(name: string): keyof typeof DOCUMENT_MIMES {
  const format = name.split(".").at(-1)?.toLowerCase();
  if (!format || !Object.hasOwn(DOCUMENT_MIMES, format))
    throw new Error("仅支持 PDF、DOCX、XLSX；旧式、宏和加密文档不支持");
  return format as keyof typeof DOCUMENT_MIMES;
}
const cell = z.union([
  z.string().max(16000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z
    .object({
      formula: z.string().max(1000),
      result: z.union([z.string(), z.number(), z.boolean()]).optional(),
    })
    .strict(),
]);
export const documentContent = z
  .object({
    paragraphs: z
      .array(
        z
          .object({
            text: z.string().max(32000),
            heading: z.number().int().min(1).max(6).optional(),
            bullet: z.boolean().optional(),
          })
          .strict(),
      )
      .max(2000)
      .optional(),
    tables: z
      .array(z.array(z.array(z.string().max(16000)).max(100)).max(1000))
      .max(20)
      .optional(),
    sheets: z
      .array(
        z
          .object({
            name: z.string().min(1).max(31),
            rows: z.array(z.array(cell).max(256)).max(10000),
          })
          .strict(),
      )
      .max(30)
      .optional(),
  })
  .strict()
  .refine((v) => JSON.stringify(v).length <= 2_000_000, "文档内容过大");
export const documentJob = z
  .object({
    action: z.enum(["inspect", "read", "write", "edit"]),
    name: z.string().min(1).max(255),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20),
    fragment: z.number().int().nonnegative().max(1000000).default(0),
    sheet: z.string().max(31).optional(),
    content: documentContent.optional(),
    replacements: z
      .array(
        z
          .object({
            old_text: z.string().min(1).max(16000),
            new_text: z.string().max(16000),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    cells: z
      .array(
        z
          .object({
            sheet: z.string().max(31),
            cell: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,5}$/),
            value: cell,
          })
          .strict(),
      )
      .max(1000)
      .optional(),
  })
  .strict();
export type DocumentJob = z.input<typeof documentJob>;
