/**
 * Direct manufacturer-CSV ingest endpoint — the Portal-MCP faucet (v2.3.51).
 *
 * The second delivery mechanism into the email-drop pipe. Where the inbound
 * receiver (/api/resend/inbound-rewards) accepts a forwarded email, this
 * accepts a CSV handed straight in by the local `refill-portal` MCP running
 * on the spa's own Mac (Playwright logs into Allē / ASPIRE / Evolus, downloads
 * the report, POSTs it here). Both end in the SAME lane-router
 * (ingestCsvByTokenRouted) → detect() → ingest → Recall.
 *
 * Request:  POST application/json  { token, filename, csv }
 * Auth:     the reward-ingest token IS the credential (unguessable, revocable,
 *           per-tenant). We do NOT trust any other header — the spa's portal
 *           credentials never leave their Mac and never reach this server.
 * Response: 200 { ok, lane, detected, reason, receipt } on a resolved token;
 *           400 only for a malformed request (missing token/csv). A bad token
 *           or unrecognized CSV returns 200 with ok:false + a reason, so the
 *           MCP can surface it without treating it as a transport failure.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { ingestCsvByTokenRouted } from "@/server/manufacturer-ingest-router";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type IngestBody = {
  token?: unknown;
  filename?: unknown;
  csv?: unknown;
};

export const Route = createFileRoute("/api/ingest/rewards")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) {
          return jsonResp(500, { error: "Server not configured" });
        }

        let body: IngestBody;
        try {
          body = JSON.parse(await request.text()) as IngestBody;
        } catch {
          return jsonResp(400, { ok: false, reason: "non_json_body" });
        }

        const token = typeof body.token === "string" ? body.token.trim() : "";
        const csv = typeof body.csv === "string" ? body.csv : "";
        const filename =
          typeof body.filename === "string" && body.filename.trim()
            ? body.filename.trim()
            : "portal-report.csv";

        if (!token) {
          return jsonResp(400, { ok: false, reason: "missing_token" });
        }
        if (!csv.trim()) {
          return jsonResp(400, { ok: false, reason: "missing_csv" });
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        let result;
        try {
          result = await ingestCsvByTokenRouted(sb, token, csv, filename);
        } catch (e) {
          console.log("[ingest-rewards] error", {
            tokenPrefix: token.slice(0, 6),
            file: filename,
            message: e instanceof Error ? e.message : "ingest_failed",
          });
          return jsonResp(200, {
            ok: false,
            reason: e instanceof Error ? e.message : "ingest_failed",
          });
        }

        console.log("[ingest-rewards] processed", {
          tokenPrefix: token.slice(0, 6),
          file: filename,
          lane: result.lane,
          ok: result.ok,
          detected: result.detected,
          reason: result.reason,
        });

        return jsonResp(200, {
          ok: result.ok,
          lane: result.lane,
          detected: result.detected,
          reason: result.reason,
          receipt: result.receipt,
        });
      },
    },
  },
});
