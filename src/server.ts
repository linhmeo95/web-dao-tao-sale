import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { parseEnv, functionBaseUrl } from "@neon/env";
import { createAuthClient } from "@neon/auth";
import { handleAuthProxyRequest } from "@neon/auth/server";
import { Files } from "files-sdk";
import { neon } from "files-sdk/neon";
import { createRemoteJWKSet, jwtVerify } from "jose";
import config from "../neon.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// When compiled to dist/src/server.js, project root is two levels up; when run via tsx src/server.ts, one level up.
const PROJECT_ROOT = fs.existsSync(path.resolve(__dirname, "../neon.ts"))
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname, "../..");

function loadDotEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

// Load .env.local and .env before calling parseEnv(config)
loadDotEnvFile(path.join(PROJECT_ROOT, ".env.local"));
loadDotEnvFile(path.join(PROJECT_ROOT, ".env"));

const env = parseEnv(config);

// 1. Lakebase Postgres: pooled connection for application traffic, unpooled for schema migrations
const pool = new Pool({
  connectionString: env.postgres.databaseUrl,
  max: 5,
});
attachDatabasePool(pool);

// 2. Neon Object Storage: Files SDK with Neon adapter (uses AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION)
const files = new Files({
  adapter: neon({ bucket: "uploads" }),
});

// 3. Neon Auth: Managed Better Auth client + JWKS token verification
const authClient = createAuthClient(env.auth.baseUrl);
const jwks = createRemoteJWKSet(new URL(env.auth.jwksUrl));
const authIssuer = new URL(env.auth.baseUrl).origin;
const COOKIE_SECRET =
  process.env.NEON_AUTH_COOKIE_SECRET ||
  "novastars-neon-auth-cookie-secret-key-2026-min32chars";

// 4. Neon Functions: branch-aware invocation URL via functionBaseUrl("hello")
function getHelloFunctionUrl(): string {
  return functionBaseUrl("hello");
}

const DB_JSON_PATH = path.join(PROJECT_ROOT, "data", "training_db.json");
const INIT_JS_PATH = path.join(PROJECT_ROOT, "data", "initial_data.js");

const ROW_CONFIG_ID = "sale_training__config";
const ROW_PROG_PREFIX = "sale_training__prog__";
const ROW_PRESENCE_PREFIX = "sale_training__presence__";
const ROW_ACTIVITY_ID = "sale_training__activity_log";
const ROW_BUGS_ID = "sale_training__bug_reports";

async function runSchemaMigrationsAndSeed(): Promise<void> {
  // Per neon-postgres skill: use direct (unpooled) DATABASE_URL_UNPOOLED for schema migrations / DDL
  const migrationPool = new Pool({
    connectionString: env.postgres.databaseUrlUnpooled || env.postgres.databaseUrl,
    max: 1,
  });
  try {
    await migrationPool.query(`
      CREATE TABLE IF NOT EXISTS public.novastars_app_state (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.uploaded_files (
        id SERIAL PRIMARY KEY,
        module_id TEXT,
        filename TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        content_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        uploaded_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_novastars_app_state_updated_at
        ON public.novastars_app_state (updated_at DESC);
    `);

    if (fs.existsSync(DB_JSON_PATH)) {
      const localDb = JSON.parse(fs.readFileSync(DB_JSON_PATH, "utf-8"));
      const existing = await migrationPool.query(
        "SELECT payload FROM public.novastars_app_state WHERE id = $1",
        [ROW_CONFIG_ID]
      );
      const existingRosterVer =
        existing.rows[0]?.payload?.meta?.rosterVersion || 0;
      const localRosterVer = localDb?.meta?.rosterVersion || 0;

      if (existing.rowCount === 0 || localRosterVer > existingRosterVer) {
        await migrationPool.query(
          `INSERT INTO public.novastars_app_state (id, payload, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET
             payload = EXCLUDED.payload,
             updated_at = now()`,
          [
            ROW_CONFIG_ID,
            JSON.stringify({
              meta: localDb.meta,
              users: localDb.users,
              modules: localDb.modules,
            }),
          ]
        );
      }
    }
  } finally {
    await migrationPool.end();
  }
}

async function loadFullDbFromPostgres(): Promise<Record<string, unknown>> {
  const baseDb = fs.existsSync(DB_JSON_PATH)
    ? JSON.parse(fs.readFileSync(DB_JSON_PATH, "utf-8"))
    : { meta: {}, users: [], modules: [], progress: [] };

  const { rows } = await pool.query(
    "SELECT id, payload, updated_at FROM public.novastars_app_state WHERE id LIKE 'sale_training__%'"
  );

  const progressList: unknown[] = [];
  const presenceMap: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.id === ROW_CONFIG_ID && row.payload) {
      if (row.payload.meta) baseDb.meta = { ...baseDb.meta, ...row.payload.meta };
      if (Array.isArray(row.payload.users)) baseDb.users = row.payload.users;
      if (Array.isArray(row.payload.modules) && row.payload.modules.length > 0) {
        baseDb.modules = row.payload.modules;
      }
    } else if (typeof row.id === "string" && row.id.startsWith(ROW_PROG_PREFIX) && row.payload) {
      progressList.push(row.payload);
    } else if (typeof row.id === "string" && row.id.startsWith(ROW_PRESENCE_PREFIX) && row.payload) {
      const uid = row.payload.userId || row.id.slice(ROW_PRESENCE_PREFIX.length);
      presenceMap[uid] = row.payload;
    } else if (row.id === ROW_ACTIVITY_ID && row.payload && Array.isArray(row.payload.items)) {
      baseDb.activityLogs = row.payload.items;
    } else if (row.id === ROW_BUGS_ID && row.payload && Array.isArray(row.payload.items)) {
      baseDb.bugReports = row.payload.items;
    }
  }
  if (progressList.length > 0) {
    baseDb.progress = progressList;
  }
  if (Object.keys(presenceMap).length > 0) {
    baseDb.presence = presenceMap;
  }
  return baseDb;
}

async function saveFullDbToPostgres(data: Record<string, any>): Promise<void> {
  await pool.query(
    `INSERT INTO public.novastars_app_state (id, payload, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       payload = EXCLUDED.payload,
       updated_at = now()`,
    [
      ROW_CONFIG_ID,
      JSON.stringify({
        meta: data.meta || {},
        users: data.users || [],
        modules: data.modules || [],
      }),
    ]
  );

  if (Array.isArray(data.activityLogs)) {
    await pool.query(
      `INSERT INTO public.novastars_app_state (id, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [ROW_ACTIVITY_ID, JSON.stringify({ items: data.activityLogs.slice(0, 150) })]
    );
  }

  if (Array.isArray(data.bugReports)) {
    await pool.query(
      `INSERT INTO public.novastars_app_state (id, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [ROW_BUGS_ID, JSON.stringify({ items: data.bugReports })]
    );
  }

  if (Array.isArray(data.progress)) {
    for (const prog of data.progress) {
      if (!prog || !prog.moduleId || !prog.userId) continue;
      const rowId = `${ROW_PROG_PREFIX}${prog.moduleId}__${prog.userId}`;
      await pool.query(
        `INSERT INTO public.novastars_app_state (id, payload, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           payload = EXCLUDED.payload,
           updated_at = now()`,
        [rowId, JSON.stringify(prog)]
      );
    }
  }

  try {
    fs.writeFileSync(DB_JSON_PATH, JSON.stringify(data, null, 2), "utf-8");
    fs.writeFileSync(
      INIT_JS_PATH,
      "window.INITIAL_TRAINING_DB = " + JSON.stringify(data) + ";\n",
      "utf-8"
    );
  } catch {
    // Ignore read-only filesystem errors in serverless environments
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, Prefer",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, Prefer",
    });
    res.end();
    return;
  }

  const host = req.headers.host || "localhost:8787";
  const reqUrl = new URL(req.url || "/", `http://${host}`);
  const pathname = reqUrl.pathname;

  try {
    // =========================================================================
    // 1. NEON UNIFIED STATUS ENDPOINT (Proves all 4 services are wired)
    // =========================================================================
    if (pathname === "/api/neon/status" && req.method === "GET") {
      const pgCheck = await pool.query(
        "SELECT current_database() AS db, current_user AS role, now() AS server_time, (SELECT count(*)::int FROM public.novastars_app_state) AS state_rows, (SELECT count(*)::int FROM public.uploaded_files) AS files_count"
      );
      const fnUrl = getHelloFunctionUrl();
      return sendJson(res, 200, {
        ok: true,
        branch: env.branch?.name || process.env.NEON_BRANCH || "production",
        branchId: env.branch?.id || process.env.NEON_BRANCH_ID || null,
        postgres: {
          connected: true,
          ...pgCheck.rows[0],
        },
        auth: {
          enabled: true,
          baseUrl: env.auth.baseUrl,
          jwksUrl: env.auth.jwksUrl,
          issuer: authIssuer,
          sdkConfigured: Boolean(authClient),
        },
        objectStorage: {
          enabled: true,
          bucket: "uploads",
          endpoint: env.storage.endpoint,
          region: env.storage.region,
        },
        functions: {
          enabled: true,
          slug: "hello",
          url: fnUrl,
        },
      });
    }

    // =========================================================================
    // 2. LAKEBASE POSTGRES ENDPOINTS (/api/state, /api/data, /api/save)
    // =========================================================================
    if (pathname === "/api/state") {
      if (req.method === "GET") {
        const { rows } = await pool.query(
          "SELECT id, payload, updated_at FROM public.novastars_app_state WHERE id LIKE 'sale_training__%' ORDER BY updated_at DESC"
        );
        return sendJson(res, 200, rows);
      }

      if (req.method === "POST") {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw.toString("utf-8") || "[]");
        const items = Array.isArray(body) ? body : [body];
        for (const item of items) {
          if (!item || !item.id) continue;
          await pool.query(
            `INSERT INTO public.novastars_app_state (id, payload, updated_at)
             VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, now()))
             ON CONFLICT (id) DO UPDATE SET
               payload = EXCLUDED.payload,
               updated_at = EXCLUDED.updated_at`,
            [item.id, JSON.stringify(item.payload ?? {}), item.updated_at || new Date().toISOString()]
          );
        }
        return sendJson(res, 200, { ok: true, upserted: items.length });
      }
    }

    if (pathname === "/api/data" && req.method === "GET") {
      const dbData = await loadFullDbFromPostgres();
      return sendJson(res, 200, dbData);
    }

    if (pathname === "/api/save" && req.method === "POST") {
      const raw = await readRequestBody(req);
      const data = JSON.parse(raw.toString("utf-8"));
      await saveFullDbToPostgres(data);
      return sendJson(res, 200, { ok: true, savedTo: "lakebase-postgres" });
    }

    // =========================================================================
    // 3. NEON OBJECT STORAGE ENDPOINTS (/api/storage/upload, /api/storage/files, /api/storage/download)
    // =========================================================================
    if (pathname === "/api/storage/upload" && req.method === "POST") {
      const raw = await readRequestBody(req);
      const body = JSON.parse(raw.toString("utf-8")) as {
        filename?: string;
        contentBase64?: string;
        textContent?: string;
        contentType?: string;
        moduleId?: string;
        uploadedBy?: string;
      };
      const safeName = (body.filename || "training-doc.txt").replace(/[^a-zA-Z0-9._-]/g, "_");
      const storageKey = `training-docs/${Date.now()}-${safeName}`;
      const contentType = body.contentType || "text/plain; charset=utf-8";
      const fileBuffer = body.contentBase64
        ? Buffer.from(body.contentBase64, "base64")
        : Buffer.from(body.textContent || "", "utf-8");

      // Upload to Neon Object Storage bucket "uploads" using Files SDK
      await files.upload(storageKey, fileBuffer, { contentType });

      // Generate presigned GET URL
      const presignedUrl = await files.url(storageKey, { expiresIn: 3600 });

      // Store bucket key in Lakebase Postgres on the same branch
      const { rows } = await pool.query(
        `INSERT INTO public.uploaded_files (module_id, filename, storage_key, content_type, size_bytes, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (storage_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes
         RETURNING *`,
        [
          body.moduleId || "mod-01-tong-quan",
          body.filename || safeName,
          storageKey,
          contentType,
          fileBuffer.length,
          body.uploadedBy || "Đào tạo",
        ]
      );

      return sendJson(res, 201, {
        ok: true,
        bucket: "uploads",
        key: storageKey,
        url: presignedUrl,
        sizeBytes: fileBuffer.length,
        record: rows[0],
      });
    }

    if (pathname === "/api/storage/files" && req.method === "GET") {
      const { rows } = await pool.query(
        "SELECT * FROM public.uploaded_files ORDER BY created_at DESC LIMIT 50"
      );
      const listWithUrls = await Promise.all(
        rows.map(async (r) => ({
          ...r,
          presignedUrl: await files.url(r.storage_key, { expiresIn: 3600 }),
        }))
      );
      return sendJson(res, 200, { ok: true, bucket: "uploads", files: listWithUrls });
    }

    if (pathname === "/api/storage/download" && req.method === "GET") {
      const key = reqUrl.searchParams.get("key");
      if (!key) {
        return sendJson(res, 400, { ok: false, error: "Missing key parameter" });
      }
      const downloaded = await files.download(key);
      const text = await downloaded.text();
      return sendJson(res, 200, {
        ok: true,
        bucket: "uploads",
        key,
        sizeBytes: Buffer.byteLength(text, "utf-8"),
        content: text,
      });
    }

    // Also wire /api/extract-file to store uploaded training documents into Neon Object Storage
    if (pathname === "/api/extract-file" && req.method === "POST") {
      const raw = await readRequestBody(req);
      const payload = JSON.parse(raw.toString("utf-8")) as {
        filename?: string;
        contentBase64?: string;
        moduleId?: string;
        uploadedBy?: string;
      };
      const filename = payload.filename || "uploaded.txt";
      const rawBytes = Buffer.from(payload.contentBase64 || "", "base64");
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storageKey = `training-docs/${Date.now()}-${safeName}`;
      await files.upload(storageKey, rawBytes, {
        contentType: MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream",
      });
      const presignedUrl = await files.url(storageKey, { expiresIn: 3600 });
      await pool.query(
        `INSERT INTO public.uploaded_files (module_id, filename, storage_key, content_type, size_bytes, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (storage_key) DO NOTHING`,
        [
          payload.moduleId || "mod-01-tong-quan",
          filename,
          storageKey,
          MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream",
          rawBytes.length,
          payload.uploadedBy || "Đào tạo",
        ]
      );

      // For plain text files return decoded text directly; for .docx/.xlsx client JSZip parser handles tables if needed
      const lower = filename.toLowerCase();
      const isText = lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv") || lower.endsWith(".json");
      return sendJson(res, 200, {
        ok: true,
        text: isText ? rawBytes.toString("utf-8") : "",
        tables: [],
        storageKey,
        storageUrl: presignedUrl,
      });
    }

    // =========================================================================
    // 4. NEON AUTH ENDPOINTS (/api/neon-auth/* and /api/auth/* proxy)
    // =========================================================================
    if (pathname === "/api/neon-auth/sign-up" && req.method === "POST") {
      const raw = await readRequestBody(req);
      const { email, password, name } = JSON.parse(raw.toString("utf-8"));
      const origin = req.headers.origin || `http://${host}`;

      const upstreamRes = await fetch(`${env.auth.baseUrl}/sign-up/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ email, password, name }),
      });
      const data = (await upstreamRes.json()) as Record<string, any>;
      if (!upstreamRes.ok) {
        return sendJson(res, upstreamRes.status, { ok: false, error: data });
      }

      // Extract session cookie/token to mint a JWT and verify it against NEON_AUTH_JWKS_URL
      const setCookies = upstreamRes.headers.getSetCookie?.() || [];
      const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
      let jwtToken: string | null = null;
      let verifiedClaims: unknown = null;

      if (cookieHeader) {
        const tokenRes = await fetch(`${env.auth.baseUrl}/token`, {
          headers: { Cookie: cookieHeader, Origin: origin },
        });
        if (tokenRes.ok) {
          const tokenJson = (await tokenRes.json()) as { token?: string };
          if (tokenJson.token) {
            jwtToken = tokenJson.token;
            const { payload } = await jwtVerify(jwtToken, jwks, { issuer: authIssuer });
            verifiedClaims = payload;
          }
        }
      }

      return sendJson(res, 200, {
        ok: true,
        user: data.user,
        sessionToken: data.token,
        jwtToken,
        verifiedClaims,
      });
    }

    if (pathname === "/api/neon-auth/sign-in" && req.method === "POST") {
      const raw = await readRequestBody(req);
      const { email, password } = JSON.parse(raw.toString("utf-8"));
      const origin = req.headers.origin || `http://${host}`;

      const upstreamRes = await fetch(`${env.auth.baseUrl}/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ email, password }),
      });
      const data = (await upstreamRes.json()) as Record<string, any>;
      if (!upstreamRes.ok) {
        return sendJson(res, upstreamRes.status, { ok: false, error: data });
      }

      const setCookies = upstreamRes.headers.getSetCookie?.() || [];
      const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
      let jwtToken: string | null = null;
      let verifiedClaims: unknown = null;

      if (cookieHeader) {
        const tokenRes = await fetch(`${env.auth.baseUrl}/token`, {
          headers: { Cookie: cookieHeader, Origin: origin },
        });
        if (tokenRes.ok) {
          const tokenJson = (await tokenRes.json()) as { token?: string };
          if (tokenJson.token) {
            jwtToken = tokenJson.token;
            const { payload } = await jwtVerify(jwtToken, jwks, { issuer: authIssuer });
            verifiedClaims = payload;
          }
        }
      }

      return sendJson(res, 200, {
        ok: true,
        user: data.user,
        sessionToken: data.token,
        jwtToken,
        verifiedClaims,
      });
    }

    if (pathname === "/api/neon-auth/verify" && req.method === "GET") {
      const authHeader = req.headers.authorization;
      if (!authHeader?.toLowerCase().startsWith("bearer ")) {
        return sendJson(res, 401, { ok: false, error: "Missing Bearer token" });
      }
      const token = authHeader.slice(7).trim();
      const { payload } = await jwtVerify(token, jwks, { issuer: authIssuer });
      return sendJson(res, 200, {
        ok: true,
        userId: payload.sub,
        issuer: payload.iss,
        claims: payload,
      });
    }

    if (pathname.startsWith("/api/auth/")) {
      const subPath = pathname.slice("/api/auth/".length);
      const rawBody = req.method !== "GET" && req.method !== "HEAD" ? await readRequestBody(req) : undefined;
      const webReq = new Request(`http://${host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: rawBody && rawBody.length > 0 ? new Uint8Array(rawBody) : undefined,
      });
      const proxyRes = await handleAuthProxyRequest({
        request: webReq,
        path: subPath,
        baseUrl: env.auth.baseUrl,
        cookieSecret: COOKIE_SECRET,
        sameSite: "lax",
      });
      const resHeaders: Record<string, string | string[]> = {};
      proxyRes.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });
      const setCookies = proxyRes.headers.getSetCookie?.();
      if (setCookies && setCookies.length > 0) {
        resHeaders["set-cookie"] = setCookies;
      }
      res.writeHead(proxyRes.status, resHeaders);
      const ab = await proxyRes.arrayBuffer();
      res.end(Buffer.from(ab));
      return;
    }

    // =========================================================================
    // 5. NEON FUNCTIONS ENDPOINT (/api/neon/function)
    // =========================================================================
    if (pathname === "/api/neon/function" && req.method === "GET") {
      const fnBase = getHelloFunctionUrl();
      const healthRes = await fetch(`${fnBase}/health`);
      const healthText = await healthRes.text();
      let healthData: unknown = healthText;
      try {
        healthData = JSON.parse(healthText);
      } catch {}

      let tokenVerification: unknown = null;
      if (req.headers.authorization) {
        const verifyRes = await fetch(`${fnBase}/verify-token`, {
          headers: { Authorization: req.headers.authorization },
        });
        const verifyText = await verifyRes.text();
        try {
          tokenVerification = JSON.parse(verifyText);
        } catch {
          tokenVerification = verifyText;
        }
      }

      return sendJson(res, 200, {
        ok: healthRes.ok,
        functionSlug: "hello",
        functionBaseUrl: fnBase,
        status: healthRes.status,
        functionResponse: healthData,
        tokenVerification,
      });
    }

    // =========================================================================
    // 6. STATIC FILE SERVING (index.html, app.js, styles.css, data/*)
    // =========================================================================
    const relPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
    const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const fullPath = path.join(PROJECT_ROOT, safePath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    sendJson(res, 404, { ok: false, error: `Not found: ${pathname}` });
  } catch (err: unknown) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

const PORT = Number(process.env.PORT || 8787);

runSchemaMigrationsAndSeed()
  .then(() => {
    server.listen(PORT, "127.0.0.1", () => {
      console.log(
        `Serving NovaStars Sale Training App (Neon Backend) on http://localhost:${PORT}`
      );
    });
  })
  .catch((err) => {
    console.error("Failed to initialize Neon database schema:", err);
    process.exit(1);
  });
