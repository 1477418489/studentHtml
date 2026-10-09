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

function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    difference |= (a[i] || 0) ^ (b[i] || 0);
  }
  return difference === 0;
}

async function authorize(request, env) {
  if (!env.ROSTER_PASSWORD) return { response: json({ error: "password_not_configured" }, 503) };
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return { response: json({ error: "invalid_request" }, 415) };
  }
  if (Number(request.headers.get("Content-Length") || 0) > 1_900_000) {
    return { response: json({ error: "payload_too_large" }, 413) };
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return { response: json({ error: "invalid_origin" }, 403) };
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return { response: json({ error: "invalid_request" }, 400) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { response: json({ error: "invalid_request" }, 400) };
  }
  if (typeof body.password !== "string" || body.password.length > 512 || !constantTimeEqual(body.password, env.ROSTER_PASSWORD)) {
    return { response: json({ error: "invalid_password" }, 401) };
  }
  return { body };
}

async function getOrCreateVault(db) {
  const existing = await db.prepare("SELECT salt, iv, ciphertext, updated_at FROM roster_vault WHERE id = 1").first();
  if (existing) return existing;

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = btoa(String.fromCharCode(...saltBytes));
  await db.prepare("INSERT INTO roster_vault (id, salt, iv, ciphertext, updated_at) VALUES (1, ?, NULL, NULL, NULL) ON CONFLICT(id) DO NOTHING")
    .bind(salt)
    .run();
  return db.prepare("SELECT salt, iv, ciphertext, updated_at FROM roster_vault WHERE id = 1").first();
}

async function handleApi(request, env) {
  if (!env.DB) return json({ error: "database_not_configured" }, 503);

  if (request.method === "POST" && new URL(request.url).pathname === "/api/unlock") {
    const auth = await authorize(request, env);
    if (auth.response) return auth.response;
    try {
      const vault = await getOrCreateVault(env.DB);
      return json({
        salt: vault.salt,
        iv: vault.iv,
        ciphertext: vault.ciphertext,
        updatedAt: vault.updated_at
      });
    } catch {
      return json({ error: "database_error" }, 500);
    }
  }

  if (request.method === "PUT" && new URL(request.url).pathname === "/api/vault") {
    const auth = await authorize(request, env);
    if (auth.response) return auth.response;
    const { iv, ciphertext } = auth.body;
    if (typeof iv !== "string" || typeof ciphertext !== "string" || iv.length > 64 || ciphertext.length > 1_800_000) {
      return json({ error: "invalid_payload" }, 400);
    }
    try {
      const vault = await getOrCreateVault(env.DB);
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
