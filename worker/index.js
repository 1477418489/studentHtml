const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });

const encoder = new TextEncoder();
const PASSWORD_ITERATIONS = 100_000;

function constantTimeEqual(left, right) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    difference |= (a[i] || 0) ^ (b[i] || 0);
  }
  return difference === 0;
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

async function hashPassword(password, salt) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations: PASSWORD_ITERATIONS
  }, material, 256);
  return toBase64(new Uint8Array(bits));
}

async function readAuthRecord(db) {
  return db.prepare("SELECT salt, password_hash FROM roster_auth WHERE id = 1").first();
}

async function readRequestBody(request) {
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return { response: json({ error: "invalid_request" }, 415) };
  if (Number(request.headers.get("Content-Length") || 0) > 1_900_000) {
    return { response: json({ error: "payload_too_large" }, 413) };
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return { response: json({ error: "invalid_origin" }, 403) };
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { response: json({ error: "invalid_request" }, 400) };
    }
    return { body };
  } catch {
    return { response: json({ error: "invalid_request" }, 400) };
  }
}

async function authorize(request, env) {
  const parsed = await readRequestBody(request);
  if (parsed.response) return parsed;
  const { body } = parsed;
  if (typeof body.password !== "string" || body.password.length > 512) {
    return { response: json({ error: "invalid_password" }, 401) };
  }

  const storedAuth = await readAuthRecord(env.DB);
  if (!storedAuth && !env.ROSTER_PASSWORD) {
    return { response: json({ error: "password_not_configured" }, 503) };
  }
  const valid = storedAuth
    ? constantTimeEqual(await hashPassword(body.password, Uint8Array.from(atob(storedAuth.salt), (character) => character.charCodeAt(0))), storedAuth.password_hash)
    : constantTimeEqual(body.password, env.ROSTER_PASSWORD);
  if (!valid) return { response: json({ error: "invalid_password" }, 401) };
  return { body };
}

async function getOrCreateVault(db) {
  const existing = await db.prepare("SELECT salt, iv, ciphertext, updated_at FROM roster_vault WHERE id = 1").first();
  if (existing) return existing;

  const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  await db.prepare("INSERT INTO roster_vault (id, salt, iv, ciphertext, updated_at) VALUES (1, ?, NULL, NULL, NULL) ON CONFLICT(id) DO NOTHING")
    .bind(salt)
    .run();
  return db.prepare("SELECT salt, iv, ciphertext, updated_at FROM roster_vault WHERE id = 1").first();
}

function vaultResponse(vault) {
  return json({
    salt: vault.salt,
    iv: vault.iv,
    ciphertext: vault.ciphertext,
    updatedAt: vault.updated_at
  });
}

async function handleSetup(request, env) {
  if (!env.SETUP_TOKEN || env.ROSTER_PASSWORD) return json({ error: "password_not_configured" }, 503);
  const parsed = await readRequestBody(request);
  if (parsed.response) return parsed.response;
  const { setupToken, password } = parsed.body;
  if (typeof setupToken !== "string" || !constantTimeEqual(setupToken, env.SETUP_TOKEN)) {
    return json({ error: "invalid_setup_token" }, 401);
  }
  if (typeof password !== "string" || password.length === 0) return json({ error: "invalid_password" }, 400);
  if (password.length > 512) return json({ error: "password_too_long" }, 400);

  if (await readAuthRecord(env.DB)) return json({ error: "already_initialized" }, 409);
  const existingVault = await env.DB.prepare("SELECT iv, ciphertext FROM roster_vault WHERE id = 1").first();
  if (existingVault?.iv && existingVault?.ciphertext) {
    return json({ error: "legacy_password_required" }, 409);
  }

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = toBase64(saltBytes);
  const passwordHash = await hashPassword(password, saltBytes);
  const result = await env.DB.prepare("INSERT INTO roster_auth (id, salt, password_hash, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(salt, passwordHash, new Date().toISOString())
    .run();
  if (result.meta?.changes !== 1) return json({ error: "already_initialized" }, 409);

  try {
    return vaultResponse(await getOrCreateVault(env.DB));
  } catch {
    return json({ error: "database_error" }, 500);
  }
}

async function handleApi(request, env) {
  if (!env.DB) return json({ error: "database_not_configured" }, 503);
  const pathname = new URL(request.url).pathname;

  if (request.method === "GET" && pathname === "/api/status") {
    try {
      const configured = Boolean(await readAuthRecord(env.DB)) || Boolean(env.ROSTER_PASSWORD);
      return json({ mode: configured ? "login" : env.SETUP_TOKEN ? "setup" : "unavailable" });
    } catch {
      return json({ error: "database_error" }, 500);
    }
  }

  if (request.method === "POST" && pathname === "/api/setup") {
    try {
      return await handleSetup(request, env);
    } catch {
      return json({ error: "database_error" }, 500);
    }
  }

  if (request.method === "POST" && pathname === "/api/unlock") {
    try {
      const auth = await authorize(request, env);
      if (auth.response) return auth.response;
      return vaultResponse(await getOrCreateVault(env.DB));
    } catch {
      return json({ error: "database_error" }, 500);
    }
  }

  if (request.method === "PUT" && pathname === "/api/vault") {
    try {
      const auth = await authorize(request, env);
      if (auth.response) return auth.response;
      const { iv, ciphertext } = auth.body;
      if (typeof iv !== "string" || typeof ciphertext !== "string" || iv.length > 64 || ciphertext.length > 1_800_000) {
        return json({ error: "invalid_payload" }, 400);
      }
      const updatedAt = new Date().toISOString();
      await env.DB.prepare("UPDATE roster_vault SET iv = ?, ciphertext = ?, updated_at = ? WHERE id = 1")
        .bind(iv, ciphertext, updatedAt)
        .run();
      return json({ updatedAt });
    } catch {
      return json({ error: "database_error" }, 500);
    }
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    return new Response(response.body, { status: response.status, headers });
  }
};
