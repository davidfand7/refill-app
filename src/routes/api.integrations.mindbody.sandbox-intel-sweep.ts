/**
 * Mindbody sandbox intel sweep (v1.43.1).
 *
 * Read-only comprehensive probe across the Mindbody Public API v6
 * surface as exposed by the free sandbox at Studio -99. Per the
 * stealth-first doctrine (feedback_stealth_first_doctrine 2026-06-03):
 * extract everything we can from anonymous-ish surface BEFORE making
 * any Go-Live request that identifies Refill to Mindbody.
 *
 * Auth chain identical to sandbox-verify route (email staff login
 * with mindbodysandboxsite@gmail.com / Apitest1234 — confirmed
 * winner per v1.42.2 4-candidate probe).
 *
 * READ ONLY. No POSTs / PUTs / DELETEs in this sweep. Sandbox writes
 * are wiped nightly anyway but we stay invisible to whoever monitors
 * -99 traffic by sticking to GETs.
 *
 * Endpoints probed (12 total):
 *   1. /site/sites       — basic
 *   2. /site/locations    — multi-location support
 *   3. /site/sessiontypes — services taxonomy (CRITICAL for treatment_type mapping)
 *   4. /site/programs     — program catalog
 *   5. /staff/staff       — staff roster (already covered, dump first 5 keys)
 *   6. /client/clients    — patient roster (already covered)
 *   7. /client/clientservices — per-client treatment history
 *   8. /appointment/staffappointments — appointments (already covered)
 *   9. /appointment/bookableitems — appointment-booking shape (writes need this)
 *  10. /subscriptions/eventids   — list of all webhook event types available
 *  11. /subscriptions/subscriptions — list current subscriptions (likely 0 in sandbox)
 *  12. /sale/sales        — sale history (revenue intel — does MB expose $ per appointment?)
 */

import { createFileRoute } from "@tanstack/react-router";

const MINDBODY_API_BASE = "https://api.mindbodyonline.com/public/v6";
const MINDBODY_WEBHOOKS_API_BASE =
  "https://mb-api.mindbodyonline.com/platform/webhooks/api/v1";
const SANDBOX_SITE_ID = "-99";
const SANDBOX_LOGIN_USERNAME = "mindbodysandboxsite@gmail.com";
const SANDBOX_LOGIN_PASSWORD = "Apitest1234";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readSafely(r: Response): Promise<{
  status: number;
  ok: boolean;
  bodyJson: unknown | null;
  bodyTextSample: string | null;
}> {
  const status = r.status;
  const ok = r.ok;
  let text: string | null = null;
  try {
    text = await r.text();
  } catch {
    /* ignore */
  }
  let bodyJson: unknown | null = null;
  if (text) {
    try {
      bodyJson = JSON.parse(text);
    } catch {
      /* non-json */
    }
  }
  return {
    status,
    ok,
    bodyJson,
    bodyTextSample: ok ? null : (text ?? "").slice(0, 200),
  };
}

type Probe = {
  label: string;
  url: string;
  base?: "public" | "webhooks";
};

const PROBES: Probe[] = [
  {
    label: "site_sites",
    url: `${MINDBODY_API_BASE}/site/sites`,
  },
  {
    label: "site_locations",
    url: `${MINDBODY_API_BASE}/site/locations`,
  },
  {
    label: "site_sessiontypes",
    url: `${MINDBODY_API_BASE}/site/sessiontypes`,
  },
  {
    label: "site_programs",
    url: `${MINDBODY_API_BASE}/site/programs`,
  },
  {
    label: "site_classdescriptions",
    url: `${MINDBODY_API_BASE}/class/classdescriptions`,
  },
  {
    label: "staff_staff",
    url: `${MINDBODY_API_BASE}/staff/staff?Limit=3`,
  },
  {
    label: "client_clients",
    url: `${MINDBODY_API_BASE}/client/clients?Limit=3`,
  },
  {
    label: "appointment_bookableitems",
    // Bookableitems requires SessionTypeId — try probing without to see
    // error shape (informative even if 4xx).
    url: `${MINDBODY_API_BASE}/appointment/bookableitems`,
  },
  {
    label: "sale_sales",
    url: `${MINDBODY_API_BASE}/sale/sales?Limit=3`,
  },
  {
    label: "sale_services",
    url: `${MINDBODY_API_BASE}/sale/services`,
  },
  {
    label: "sale_packages",
    url: `${MINDBODY_API_BASE}/sale/packages`,
  },
  {
    label: "subscriptions_eventids",
    url: `${MINDBODY_WEBHOOKS_API_BASE}/eventIds`,
    base: "webhooks",
  },
  {
    label: "subscriptions_subscriptions",
    url: `${MINDBODY_WEBHOOKS_API_BASE}/subscriptions`,
    base: "webhooks",
  },
];

export const Route = createFileRoute(
  "/api/integrations/mindbody/sandbox-intel-sweep",
)({
  server: {
    handlers: {
      GET: async () => {
        const apiKey = process.env.MINDBODY_SANDBOX_API_KEY?.replace(
          /\s+/g,
          "",
        );
        if (!apiKey) {
          return jsonResp(500, {
            error: "MINDBODY_SANDBOX_API_KEY not configured",
          });
        }

        const results: Record<string, unknown> = {
          ranAt: new Date().toISOString(),
        };

        // ── Get UserToken via confirmed sandbox login
        let accessToken: string | null = null;
        try {
          const r = await fetch(`${MINDBODY_API_BASE}/usertoken/issue`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Api-Key": apiKey,
              SiteId: SANDBOX_SITE_ID,
            },
            body: JSON.stringify({
              Username: SANDBOX_LOGIN_USERNAME,
              Password: SANDBOX_LOGIN_PASSWORD,
            }),
          });
          const parsed = await readSafely(r);
          if (
            parsed.ok &&
            parsed.bodyJson &&
            typeof parsed.bodyJson === "object"
          ) {
            const j = parsed.bodyJson as Record<string, unknown>;
            if (typeof j.AccessToken === "string") {
              accessToken = j.AccessToken;
            }
          }
          results.auth = { status: parsed.status, ok: parsed.ok };
        } catch (e) {
          results.auth = {
            error: e instanceof Error ? e.message : "unknown",
          };
        }

        if (!accessToken) {
          return jsonResp(200, {
            ...results,
            stoppedAt: "no_access_token",
          });
        }

        // ── Run all probes
        const probeResults: Record<string, unknown> = {};
        for (const p of PROBES) {
          try {
            const r = await fetch(p.url, {
              method: "GET",
              headers: {
                "Api-Key": apiKey,
                SiteId: SANDBOX_SITE_ID,
                Authorization: `Bearer ${accessToken}`,
              },
            });
            const parsed = await readSafely(r);
            const summary: Record<string, unknown> = {
              url: p.url,
              status: parsed.status,
              ok: parsed.ok,
            };
            if (parsed.ok && parsed.bodyJson && typeof parsed.bodyJson === "object") {
              const b = parsed.bodyJson as Record<string, unknown>;
              const topkeys = Object.keys(b);
              summary.topKeys = topkeys;
              const pagination = b.PaginationResponse;
              if (pagination && typeof pagination === "object") {
                summary.pagination = pagination;
              }
              // For each top-level array, surface count + first item key set.
              const arrayShapes: Record<string, unknown> = {};
              for (const k of topkeys) {
                const v = b[k];
                if (Array.isArray(v)) {
                  arrayShapes[k] = {
                    count: v.length,
                    firstItemKeys:
                      v.length > 0 && v[0] && typeof v[0] === "object"
                        ? Object.keys(v[0] as Record<string, unknown>)
                        : null,
                    firstItemSample: v.length > 0 ? v[0] : null,
                  };
                }
              }
              if (Object.keys(arrayShapes).length > 0) {
                summary.arrays = arrayShapes;
              }
            } else if (!parsed.ok) {
              summary.errorSample = parsed.bodyTextSample;
              if (parsed.bodyJson && typeof parsed.bodyJson === "object") {
                summary.errorBody = parsed.bodyJson;
              }
            }
            probeResults[p.label] = summary;
          } catch (e) {
            probeResults[p.label] = {
              url: p.url,
              fetchError: e instanceof Error ? e.message : "unknown",
            };
          }
        }
        results.probes = probeResults;

        // ── Roll-up summary (counts of working endpoints)
        let ok = 0;
        let fail = 0;
        const failedLabels: string[] = [];
        for (const [label, r] of Object.entries(probeResults)) {
          const s = r as { ok?: boolean };
          if (s.ok) ok++;
          else {
            fail++;
            failedLabels.push(label);
          }
        }
        results.summary = {
          totalProbed: PROBES.length,
          ok,
          fail,
          failedLabels,
        };

        return jsonResp(200, results);
      },
    },
  },
});
