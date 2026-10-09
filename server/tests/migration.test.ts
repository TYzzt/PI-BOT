import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { Vault } from "../src/security.js";
const url = process.env.T_AGNET_TEST_DATABASE_URL;
test("Python AES-GCM ciphertext remains decryptable in Node", async () => {
  const fixture = JSON.parse(
      await readFile(new URL("./fixtures/vault.json", import.meta.url), "utf8"),
    ),
    dir = await mkdtemp(join(tmpdir(), "tagent-vault-"));
  try {
    const path = join(dir, "vault.json");
    await writeFile(path, JSON.stringify(fixture.vault));
    const vault = new Vault(path);
    assert.equal(vault.open(fixture.value, fixture.id), "legacy-secret");
    assert.equal(
      vault.open(vault.seal("new-secret", fixture.id, 4), fixture.id),
      "new-secret",
    );
    assert.throws(() => vault.open(fixture.value, randomUUID()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test(
  "all existing Alembic versions upgrade without Python or losing identity",
  { skip: !url },
  async (t) => {
    const admin = new Database(url!);
    try {
      for (const version of [
        "20260925_0001",
        "20260925_0002",
        "20260926_0003",
        "20260926_0004",
        "20260926_0005",
      ])
        await t.test(version, async () => {
          const name = `migration_${randomUUID().replaceAll("-", "")}`;
          await admin.pool.query(`CREATE DATABASE ${name}`);
          const u = new URL(url!);
          u.pathname = "/" + name;
          const db = new Database(u.toString());
          try {
            await db.pool.query(
              await readFile(
                new URL(`./fixtures/legacy-${version}.sql`, import.meta.url),
                "utf8",
              ),
            );
            const id = randomUUID();
            await db.pool.query(
              "INSERT INTO users(user_id,password_hash,singleton,created_at) VALUES($1,$2,true,now())",
              [id, "existing-hash"],
            );
            const deviceId = randomUUID(), documentId = randomUUID();
            const shared = ["20260926_0004", "20260926_0005"].includes(version);
            const saved = { config: { name: "existing" }, secret: { ciphertext: "preserved-ciphertext" }, deleted: false };
            if (shared) {
              await db.pool.query("INSERT INTO devices(device_id,public_key,label,capabilities,created_at) VALUES($1,'existing-key','Mac','[]',now())", [deviceId]);
              await db.pool.query("INSERT INTO shared_documents(id,kind,device_id,version,data) VALUES($1,'model',$2,3,$3)", [documentId, deviceId, saved]);
              await db.pool.query("INSERT INTO shared_revisions(document_id,version,data) VALUES($1,3,$2)", [documentId, saved]);
              await db.pool.query("INSERT INTO shared_receipts(id,digest,result) VALUES('existing-receipt','existing-digest',$1)", [{ id: documentId, version: 3 }]);
            }
            await migrate(db);
            await migrate(db);
            if (shared) {
              assert.deepEqual((await db.pool.query("SELECT data FROM shared_documents WHERE id=$1", [documentId])).rows[0].data, saved);
              assert.deepEqual((await db.pool.query("SELECT data FROM shared_revisions WHERE document_id=$1", [documentId])).rows[0].data, saved);
              assert.equal((await db.pool.query("SELECT digest FROM shared_receipts WHERE id='existing-receipt'")).rows[0].digest, "existing-digest");
            }
            assert.equal(
              (await db.pool.query("SELECT user_id,password_hash FROM users"))
                .rows[0].user_id,
              id,
            );
            assert.equal(
              (await db.pool.query("SELECT password_hash FROM users")).rows[0]
                .password_hash,
              "existing-hash",
            );
            assert.equal(
              (
                await db.pool.query(
                  "SELECT version FROM node_migrations WHERE version='0001'",
                )
              ).rowCount,
              1,
            );
            const columns = await db.pool.query(
              "SELECT is_nullable FROM information_schema.columns WHERE table_name='shared_documents' AND column_name='device_id'",
            );
            assert.equal(columns.rows[0].is_nullable, "YES");
          } finally {
            await db.close();
            await admin.pool.query(`DROP DATABASE ${name} WITH (FORCE)`);
          }
        });
    } finally {
      await admin.close();
    }
  },
);
