import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { parseEnv } from "@neon/env";
import { Files } from "files-sdk";
import { neon } from "files-sdk/neon";
import { createRemoteJWKSet, jwtVerify } from "jose";
import config from "./neon.js";

// Resolve and validate all declared Neon service env vars against neon.ts
const env = parseEnv(config);

// Module-scope pg Pool (reused across requests on the same Neon Function isolate)
const pool = new Pool({
  connectionString: env.postgres.databaseUrl,
  max: 5,
});
attachDatabasePool(pool);

// Neon Object Storage client via Files SDK (reads AWS_* env vars injected by Neon)
const files = new Files({
  adapter: neon({ bucket: "uploads" }),
});

// Neon Auth JWKS verifier
const jwks = createRemoteJWKSet(new URL(env.auth.jwksUrl));
const issuer = new URL(env.auth.baseUrl).origin;

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await pool.query(`
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
  `);
  schemaReady = true;
}

function corsHeaders(request?: Request): Record<string, string> {
  const origin = request?.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, Prefer",
    "Content-Type": "application/json; charset=utf-8",
  };
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    try {
      await ensureSchema();

      // 1. Health & Service Wiring Check
      if (request.method === "GET" && (pathname === "/" || pathname === "/health")) {
        const dbRes = await pool.query(
          "SELECT current_database() AS db, current_user AS role, now() AS server_time, (SELECT count(*)::int FROM public.novastars_app_state) AS state_rows, (SELECT count(*)::int FROM public.uploaded_files) AS uploaded_files_count"
        );
        return new Response(
          JSON.stringify({
            ok: true,
            service: "neon-function-hello",
            message: "Hello from Neon Functions (NovaStars Sale Training Backend)",
            branch: env.branch?.name || process.env.NEON_BRANCH || "production",
            branchId: env.branch?.id || process.env.NEON_BRANCH_ID || null,
            postgres: dbRes.rows[0],
            auth: {
              baseUrl: env.auth.baseUrl,
              jwksUrl: env.auth.jwksUrl,
              issuer,
            },
            storage: {
              bucket: "uploads",
              endpoint: env.storage.endpoint,
              region: env.storage.region,
            },
          }),
          { status: 200, headers: corsHeaders(request) }
        );
      }

      // 2. App State Sync (Lakebase Postgres)
      if (pathname === "/state") {
        if (request.method === "GET") {
          const { rows } = await pool.query(
            "SELECT id, payload, updated_at FROM public.novastars_app_state WHERE id LIKE 'sale_training__%' ORDER BY updated_at DESC"
          );
          return new Response(JSON.stringify(rows), {
            status: 200,
            headers: corsHeaders(request),
          });
        }

        if (request.method === "POST") {
          const body = await request.json();
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
          return new Response(JSON.stringify({ ok: true, upserted: items.length }), {
            status: 200,
            headers: corsHeaders(request),
          });
        }
      }

      // 3. Object Storage Upload & Presigned URLs (paired with Lakebase Postgres)
      if (pathname === "/storage/upload" && request.method === "POST") {
        const body = (await request.json()) as {
          filename?: string;
          contentBase64?: string;
          textContent?: string;
          contentType?: string;
          moduleId?: string;
          uploadedBy?: string;
        };
        const rawFilename = (body.filename || "document.txt").replace(/[^a-zA-Z0-9._-]/g, "_");
        const storageKey = `training-docs/${Date.now()}-${rawFilename}`;
        const contentType = body.contentType || "application/octet-stream";
        const buffer = body.contentBase64
          ? Buffer.from(body.contentBase64, "base64")
          : Buffer.from(body.textContent || "", "utf-8");

        await files.upload(storageKey, buffer, { contentType });
        const presignedUrl = await files.url(storageKey, { expiresIn: 3600 });

        const { rows } = await pool.query(
          `INSERT INTO public.uploaded_files (module_id, filename, storage_key, content_type, size_bytes, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (storage_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes
           RETURNING *`,
          [
            body.moduleId || "mod-01-tong-quan",
            body.filename || rawFilename,
            storageKey,
            contentType,
            buffer.length,
            body.uploadedBy || "Đào tạo",
          ]
        );

        return new Response(
          JSON.stringify({
            ok: true,
            bucket: "uploads",
            key: storageKey,
            url: presignedUrl,
            sizeBytes: buffer.length,
            record: rows[0],
          }),
          { status: 201, headers: corsHeaders(request) }
        );
      }

      if (pathname === "/storage/files" && request.method === "GET") {
        const { rows } = await pool.query(
          "SELECT * FROM public.uploaded_files ORDER BY created_at DESC LIMIT 50"
        );
        const enriched = await Promise.all(
          rows.map(async (r) => ({
            ...r,
            presignedUrl: await files.url(r.storage_key, { expiresIn: 3600 }),
          }))
        );
        return new Response(JSON.stringify({ ok: true, files: enriched }), {
          status: 200,
          headers: corsHeaders(request),
        });
      }

      // 4. Neon Auth JWT Verification endpoint
      if (pathname === "/verify-token" && request.method === "GET") {
        const authHeader = request.headers.get("authorization");
        if (!authHeader?.toLowerCase().startsWith("bearer ")) {
          return new Response(
            JSON.stringify({ ok: false, error: "Missing Bearer token" }),
            { status: 401, headers: corsHeaders(request) }
          );
        }
        const token = authHeader.slice(7).trim();
        try {
          const { payload } = await jwtVerify(token, jwks, { issuer });
          if (!payload.sub) {
            return new Response(
              JSON.stringify({ ok: false, error: "Token missing sub claim" }),
              { status: 401, headers: corsHeaders(request) }
            );
          }
          return new Response(
            JSON.stringify({
              ok: true,
              verifiedBy: "neon-function-hello",
              userId: payload.sub,
              issuer: payload.iss,
              claims: payload,
            }),
            { status: 200, headers: corsHeaders(request) }
          );
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : "Invalid JWT",
            }),
            { status: 401, headers: corsHeaders(request) }
          );
        }
      }

      return new Response(
        JSON.stringify({ ok: false, error: `Route not found: ${pathname}` }),
        { status: 404, headers: corsHeaders(request) }
      );
    } catch (err: unknown) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
        { status: 500, headers: corsHeaders(request) }
      );
    }
  },
};
