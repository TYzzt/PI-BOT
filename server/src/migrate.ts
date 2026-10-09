import { readFile } from "node:fs/promises";
import { Database } from "./db.js";
import { settings } from "./config.js";
export async function migrate(db: Database) {
  await db.tx(async (tx) => {
    await tx.rows(
      "CREATE TABLE IF NOT EXISTS node_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    if (await tx.one("SELECT 1 FROM node_migrations WHERE version='0001'"))
      return;
    const existing = await tx.one("SELECT to_regclass('public.users') AS name");
    if (existing?.name) {
      const hasVersion = await tx.one(
        "SELECT to_regclass('public.alembic_version') AS name",
      );
      if (!hasVersion?.name) throw new Error("旧库缺少迁移版本，拒绝修改");
      const version = (await tx.one("SELECT version_num FROM alembic_version"))
        ?.version_num;
      if (version !== "20260926_0005") {
        if (
          ![
            "20260925_0001",
            "20260925_0002",
            "20260926_0003",
            "20260926_0004",
          ].includes(version)
        )
          throw new Error("未知旧库迁移版本");
        await tx.rows(
          await readFile(
            new URL(`../migrations/upgrade-${version}.sql`, import.meta.url),
            "utf8",
          ),
        );
      }
    } else {
      await tx.rows(
        await readFile(
          new URL("../migrations/0001-baseline.sql", import.meta.url),
          "utf8",
        ),
      );
    }
    await tx.rows("INSERT INTO node_migrations(version) VALUES('0001')");
  });
}
if (process.argv[1]?.endsWith("/migrate.ts")) {
  const db = new Database(settings().databaseUrl);
  try {
    await migrate(db);
  } finally {
    await db.close();
  }
}
