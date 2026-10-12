import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker/index.js";

const origin = "https://roster.example";
const password = "test-password";
const iv = Buffer.alloc(12, 1).toString("base64");
const ciphertext = Buffer.alloc(32, 2).toString("base64");

function environment(t, overrides = {}) {
  const database = new DatabaseSync(":memory:");
  for (const migration of ["0001_create_roster_vault.sql", "0002_create_roster_auth.sql"]) {
    database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  t.after(() => database.close());
  return {
    SETUP_TOKEN: "test-setup-token",
    DB: {
      prepare(sql) {
        const statement = database.prepare(sql);
        let values = [];
        return {
          bind(...bindings) { values = bindings; return this; },
          async first() { return statement.get(...values) ?? null; },
          async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; }
        };
      }
    },
    ASSETS: { fetch: async () => new Response("<!doctype html><title>名册</title>") },
    ...overrides
  };
}

async function api(env, path, method = "GET", body, headers = {}) {
  const request = new Request(`${origin}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const response = await worker.fetch(request, env);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function setup(env) {
  const result = await api(env, "/api/setup", "POST", { setupToken: env.SETUP_TOKEN, password });
  assert.equal(result.status, 200);
  return result.body;
}

function save(env, baseUpdatedAt, value = ciphertext) {
  return api(env, "/api/vault", "PUT", { password, baseUpdatedAt, supportsJourney: true, iv, ciphertext: value });
}

test("首次设置、密码校验和加密名册往返", async (t) => {
  const env = environment(t);
  assert.equal((await api(env, "/api/status")).body.mode, "setup");
  assert.equal((await api(env, "/api/setup", "POST", { setupToken: "wrong", password })).status, 401);
  assert.equal((await api(env, "/api/setup", "POST", { setupToken: env.SETUP_TOKEN, password: "" })).status, 400);
  const vault = await setup(env);
  assert.equal(vault.updatedAt, null);
  assert.equal(Buffer.from(vault.salt, "base64").length, 16);
  const auth = await env.DB.prepare("SELECT password_hash FROM roster_auth").first();
  assert.notEqual(auth.password_hash, password);
  assert.equal((await api(env, "/api/status")).body.mode, "login");
  assert.equal((await api(env, "/api/setup", "POST", { setupToken: env.SETUP_TOKEN, password })).status, 409);
  assert.equal((await api(env, "/api/unlock", "POST", { password: "wrong" })).status, 401);

  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: Buffer.from(vault.salt, "base64"), iterations: 600_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const records = [{ studentName: "测试学生", className: "一班", status: "checked" }];
  const journey = { stations: [{ id: "school", name: "学校南门" }, { id: "east", name: "幸福里东门" }], stopIds: ["school", "east"], currentStopId: "east", completed: false };
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64") }, key, encoder.encode(JSON.stringify({ version: 1, records, journey })));
  const saved = await save(env, null, Buffer.from(encrypted).toString("base64"));
  assert.equal(saved.status, 200);
  const loaded = await api(env, "/api/unlock", "POST", { password });
  assert.equal(loaded.body.updatedAt, saved.body.updatedAt);
  assert.equal(loaded.body.salt, vault.salt);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(loaded.body.iv, "base64") }, key, Buffer.from(loaded.body.ciphertext, "base64"));
  const payload = JSON.parse(new TextDecoder().decode(plaintext));
  assert.deepEqual(payload.records, records);
  assert.deepEqual(payload.journey, journey);
  assert.equal(loaded.headers.get("Cache-Control"), "no-store");
});

test("两个设备持有同一版本时只允许一次保存，重新加载后可继续保存", async (t) => {
  const env = environment(t, { ROSTER_PASSWORD: password });
  await api(env, "/api/unlock", "POST", { password });
  const first = await save(env, null);
  const otherCiphertext = Buffer.alloc(32, 3).toString("base64");
  const results = await Promise.all([
    save(env, first.body.updatedAt, ciphertext),
    save(env, first.body.updatedAt, otherCiphertext)
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).body.error, "vault_conflict");
  const loaded = (await api(env, "/api/unlock", "POST", { password })).body;
  assert.equal(loaded.ciphertext, results[0].status === 200 ? ciphertext : otherCiphertext);
  assert.ok(Date.parse(loaded.updatedAt) > Date.parse(first.body.updatedAt));
  const retried = await save(env, loaded.updatedAt, otherCiphertext);
  assert.equal(retried.status, 200);
  assert.ok(Date.parse(retried.body.updatedAt) > Date.parse(loaded.updatedAt));
  assert.equal((await save(env, null)).status, 409);
});

test("过期客户端和无效密文不能覆盖已有名册", async (t) => {
  const env = environment(t, { ROSTER_PASSWORD: password });
  await api(env, "/api/unlock", "POST", { password });
  const saved = await save(env, null);
  const legacy = await api(env, "/api/vault", "PUT", { password, iv, ciphertext });
  assert.equal(legacy.status, 428);
  assert.equal(legacy.body.error, "client_update_required");
  for (const supportsJourney of [undefined, false, "true"]) {
    const oldPage = await api(env, "/api/vault", "PUT", { password, baseUpdatedAt: saved.body.updatedAt, iv, ciphertext, supportsJourney });
    assert.equal(oldPage.status, 428);
    assert.equal(oldPage.body.error, "client_update_required");
  }
  const missingVersion = await api(env, "/api/vault", "PUT", { password, supportsJourney: true, iv, ciphertext });
  assert.equal(missingVersion.status, 428);
  for (const patch of [{ iv: "" }, { ciphertext: "" }, { iv: "invalid" }, { ciphertext: "!".repeat(24) }, { baseUpdatedAt: "invalid" }]) {
    const result = await api(env, "/api/vault", "PUT", { password, baseUpdatedAt: saved.body.updatedAt, supportsJourney: true, iv, ciphertext, ...patch });
    assert.equal(result.status, 400);
  }
  const oversized = await save(env, saved.body.updatedAt, "A".repeat(1_800_004));
  assert.equal(oversized.status, 413);
  const loaded = (await api(env, "/api/unlock", "POST", { password })).body;
  assert.equal(loaded.ciphertext, ciphertext);
  assert.equal(loaded.updatedAt, saved.body.updatedAt);
});

test("请求格式、来源和密码错误在写入前拒绝", async (t) => {
  const env = environment(t, { ROSTER_PASSWORD: password });
  assert.equal((await api(env, "/api/unlock", "POST", { password }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await api(env, "/api/unlock", "POST", { password }, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await api(env, "/api/unlock", "POST", [])).status, 400);
  assert.equal((await api(env, "/api/unlock", "POST", { password: 123 })).status, 401);
  assert.equal((await api(env, "/api/unlock", "POST", { password: "wrong" })).status, 401);
  assert.equal(await env.DB.prepare("SELECT id FROM roster_vault").first(), null);
});

test("没有 Content-Length 的超大请求也受限并停止读取", async (t) => {
  const env = environment(t, { ROSTER_PASSWORD: password });
  let cancelled = false;
  let chunksRead = 0;
  const body = new ReadableStream({
    pull(controller) { chunksRead += 1; controller.enqueue(new Uint8Array(100_000)); },
    cancel() { cancelled = true; }
  });
  const response = await worker.fetch(new Request(`${origin}/api/vault`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half"
  }), env);
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.ok(chunksRead <= 21);
});

test("兼容旧版密码并阻止重新初始化已有加密数据", async (t) => {
  const env = environment(t, { ROSTER_PASSWORD: password });
  assert.equal((await api(env, "/api/status")).body.mode, "login");
  assert.equal((await api(env, "/api/unlock", "POST", { password })).status, 200);
  assert.equal((await save(env, null)).status, 200);
  delete env.ROSTER_PASSWORD;
  const result = await api(env, "/api/setup", "POST", { setupToken: env.SETUP_TOKEN, password: "new-password" });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "legacy_password_required");
});

test("缺少配置时明确失败，静态资源带安全响应头", async (t) => {
  const env = environment(t, { SETUP_TOKEN: undefined });
  assert.equal((await api(env, "/api/status")).body.mode, "unavailable");
  assert.equal((await api({ ...env, DB: undefined }, "/api/status")).status, 503);
  assert.equal((await api(env, "/api/unknown")).status, 404);
  const response = await worker.fetch(new Request(origin), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.ok(response.headers.get("Content-Security-Policy").includes("frame-ancestors 'none'"));
});
