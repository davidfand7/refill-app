/**
 * Mindbody sandbox-verify smoke route (v1.42.2).
 *
 * Hits Mindbody Public API v6 against Studio ID -99 (free sandbox) and
 * returns the RAW response shape from every step so we can ground-truth
 * v1.37.0 connector assumptions against actual Mindbody behavior.
 *
 * This is the v1.35.x-debug-arc-style unlock memory promised for
 * Mindbody: every guess in the connector — mindbodyFetch headers,
 * MindbodyAppointment field names, listMindbodyAppointments pagination,
 * status mapper edge cases — gets verified in one focused session.
 *
 * Auth chain per scout-confirmed pattern (a4a953fcb 2026-06-03):
 *   1. POST /public/v6/usertoken/issue
 *      Headers: Content-Type, Api-Key=<MINDBODY_SANDBOX_API_KEY>, SiteId=-99
 *      Body: { "Username": "Siteowner", "Password": "apitest1234" }
 *      → returns { TokenType: "Bearer", AccessToken: "...", User: {...} }
 *
 *   2. GET <any-public-v6-endpoint>
 *      Headers: Api-Key, SiteId=-99, Authorization: Bearer <AccessToken>
 *
 * Sandbox refreshes nightly at midnight PST — any writes vanish.
 *
 * NOT gated behind auth: this hits sandbox-only credentials + sandbox
 * site -99 (publicly documented). Returns are useful for debugging,
 * not sensitive. Will pull this route before any production push.
 */

import { createFileRoute } from "@tanstack/react-router";

const MINDBODY_API_BASE = "https://api.mindbodyonline.com/public/v6";
const SANDBOX_SITE_ID = "-99";

/**
 * v1.42.2.1: first sandbox-verify run came back with 403 "Staff identity
 * authentication failed" (code DeniedAccess) from `/usertoken/issue` when
 * sending the scout-recommended Username=Siteowner, Password=apitest1234.
 * Api-Key + SiteId were accepted (otherwise we&apos;d get 401). The staff
 * creds got rejected.
 *
 * Four auth-combo candidates worth trying:
 *   1. Source-credential auth: Username="_Get Refill", Password=&lt;SOURCE&gt;
 *      (the v1.35.x &quot;use what we actually have in CF&quot; move; per scout,
 *      source-cred auth is the &quot;simulate staff on behalf of consumer&quot;
 *      path which also yields a Bearer token)
 *   2. Email staff auth: Username="mindbodysandboxsite@gmail.com",
 *      Password="Apitest1234" (verbatim from the sandbox signup screen)
 *   3. Siteowner staff auth, capital-A: Username="Siteowner",
 *      Password="Apitest1234" (case correction)
 *   4. Siteowner staff auth, lowercase-a: Username="Siteowner",
 *      Password="apitest1234" (scout claim verbatim — what failed v1)
 *
 * Whichever succeeds tells us the canonical sandbox auth path for the
 * Mindbody connector going forward.
 */
type AuthCandidate = {
  label: string;
  username: string;
  password: string;
  passwordSource: "constant" | "env_source_password";
};

const SANDBOX_SITE_LOGIN_EMAIL = "mindbodysandboxsite@gmail.com";
const SANDBOX_SITE_LOGIN_PASSWORD_CAP = "Apitest1234";
const SANDBOX_STAFF_USERNAME = "Siteowner";
const SANDBOX_STAFF_PASSWORD_CAP = "Apitest1234";
const SANDBOX_STAFF_PASSWORD_LOWER = "apitest1234";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readResponseSafely(r: Response): Promise<{
  status: number;
  ok: boolean;
  bodyJson: unknown | null;
  bodyText: string | null;
  contentType: string | null;
  errorParsing: string | null;
}> {
  const status = r.status;
  const ok = r.ok;
  const contentType = r.headers.get("content-type");
  let bodyText: string | null = null;
  let bodyJson: unknown | null = null;
  let errorParsing: string | null = null;
  try {
    bodyText = await r.text();
  } catch (e) {
    errorParsing = `read_text: ${e instanceof Error ? e.message : "unknown"}`;
  }
  if (bodyText) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch (e) {
      errorParsing = `parse_json: ${
        e instanceof Error ? e.message : "unknown"
      }`;
    }
  }
  return { status, ok, bodyJson, bodyText, contentType, errorParsing };
}

export const Route = createFileRoute(
  "/api/integrations/mindbody/sandbox-verify",
)({
  server: {
    handlers: {
      GET: async () => {
        const apiKey = process.env.MINDBODY_SANDBOX_API_KEY?.replace(
          /\s+/g,
          "",
        );
        const sourcePassword =
          process.env.MINDBODY_SANDBOX_SOURCE_PASSWORD?.replace(/\s+/g, "");

        if (!apiKey) {
          return jsonResp(500, {
            error: "MINDBODY_SANDBOX_API_KEY not configured",
            apiKeyPresent: false,
            sourcePasswordPresent: Boolean(sourcePassword),
          });
        }

        // v1.35.4 doctrine: length-log credentials so type-confusion
        // (API key vs OAuth secret vs source password) surfaces in the
        // smoke output, not buried in CF logs.
        const apiKeyLen = apiKey.length;
        const sourcePasswordLen = sourcePassword ? sourcePassword.length : 0;

        const results: Record<string, unknown> = {
          ranAt: new Date().toISOString(),
          credentialLengths: {
            apiKeyLen,
            sourcePasswordLen,
          },
        };

        // ── Step 1: try multiple auth combos against /usertoken/issue.
        const tokenUrl = `${MINDBODY_API_BASE}/usertoken/issue`;
        const candidates: AuthCandidate[] = [
          {
            label: "source_credential",
            username: "_Get Refill",
            password: sourcePassword ?? "",
            passwordSource: "env_source_password",
          },
          {
            label: "site_email",
            username: SANDBOX_SITE_LOGIN_EMAIL,
            password: SANDBOX_SITE_LOGIN_PASSWORD_CAP,
            passwordSource: "constant",
          },
          {
            label: "siteowner_capital_A",
            username: SANDBOX_STAFF_USERNAME,
            password: SANDBOX_STAFF_PASSWORD_CAP,
            passwordSource: "constant",
          },
          {
            label: "siteowner_lowercase_a",
            username: SANDBOX_STAFF_USERNAME,
            password: SANDBOX_STAFF_PASSWORD_LOWER,
            passwordSource: "constant",
          },
        ];

        const candidateResults: Record<string, unknown> = {};
        let accessToken: string | null = null;
        let winningCandidate: string | null = null;

        for (const c of candidates) {
          if (!c.password) {
            candidateResults[c.label] = {
              skipped: "password not configured",
            };
            continue;
          }
          try {
            const r = await fetch(tokenUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Api-Key": apiKey,
                SiteId: SANDBOX_SITE_ID,
              },
              body: JSON.stringify({
                Username: c.username,
                Password: c.password,
              }),
            });
            const parsed = await readResponseSafely(r);
            candidateResults[c.label] = {
              username: c.username,
              passwordSource: c.passwordSource,
              passwordLen: c.password.length,
              ...parsed,
            };
            if (
              parsed.ok &&
              parsed.bodyJson &&
              typeof parsed.bodyJson === "object" &&
              !accessToken
            ) {
              const j = parsed.bodyJson as Record<string, unknown>;
              const at = j.AccessToken;
              if (typeof at === "string") {
                accessToken = at;
                winningCandidate = c.label;
              }
            }
          } catch (e) {
            candidateResults[c.label] = {
              username: c.username,
              passwordSource: c.passwordSource,
              fetchError: e instanceof Error ? e.message : "unknown",
            };
          }
        }

        results.step1_usertoken_issue = {
          url: tokenUrl,
          winningCandidate,
          candidates: candidateResults,
        };

        if (!accessToken) {
          // Stop here — without a token nothing downstream will work.
          return jsonResp(200, {
            ...results,
            stoppedAt: "no_access_token_returned",
          });
        }

        // ── Step 2: List sites (basic smoke that auth chain works).
        const sitesUrl = `${MINDBODY_API_BASE}/site/sites`;
        try {
          const r = await fetch(sitesUrl, {
            method: "GET",
            headers: {
              "Api-Key": apiKey,
              SiteId: SANDBOX_SITE_ID,
              Authorization: `Bearer ${accessToken}`,
            },
          });
          results.step2_site_sites = {
            url: sitesUrl,
            ...(await readResponseSafely(r)),
          };
        } catch (e) {
          results.step2_site_sites = {
            url: sitesUrl,
            fetchError: e instanceof Error ? e.message : "unknown",
          };
        }

        // ── Step 3: List staff (next-most-common read).
        const staffUrl = `${MINDBODY_API_BASE}/staff/staff`;
        try {
          const r = await fetch(staffUrl, {
            method: "GET",
            headers: {
              "Api-Key": apiKey,
              SiteId: SANDBOX_SITE_ID,
              Authorization: `Bearer ${accessToken}`,
            },
          });
          results.step3_staff_staff = {
            url: staffUrl,
            ...(await readResponseSafely(r)),
          };
        } catch (e) {
          results.step3_staff_staff = {
            url: staffUrl,
            fetchError: e instanceof Error ? e.message : "unknown",
          };
        }

        // ── Step 4 (v1.42.4): walk all staff in batches to find one
        // with non-empty Appointments in window. Wider window (-1y to
        // +1y) to catch any test bookings in past/future. Stop on
        // first batch with results; dump first 2 appointments verbatim
        // so connector field-name assumptions get ground-truthed.
        const now = new Date();
        const startDate = new Date(
          now.getTime() - 365 * 24 * 60 * 60 * 1000,
        )
          .toISOString()
          .slice(0, 10);
        const endDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        // Pull all staff IDs from step 3.
        const staffIds: string[] = [];
        const s3 = results.step3_staff_staff as
          | Record<string, unknown>
          | undefined;
        if (s3 && typeof s3.bodyJson === "object" && s3.bodyJson !== null) {
          const sb = s3.bodyJson as Record<string, unknown>;
          const sm = sb.StaffMembers;
          if (Array.isArray(sm)) {
            for (const m of sm) {
              if (m && typeof m === "object") {
                const id = (m as Record<string, unknown>).Id;
                if (typeof id === "number" || typeof id === "string") {
                  staffIds.push(String(id));
                }
              }
            }
          }
        }

        const STAFF_BATCH = 20;
        const walkResults: Record<string, unknown> = {
          window: { startDate, endDate },
          staffIdsAvailable: staffIds.length,
          staffBatchSize: STAFF_BATCH,
          batches: [] as unknown[],
        };
        let foundNonEmpty = false;

        for (let i = 0; i < staffIds.length && !foundNonEmpty; i += STAFF_BATCH) {
          const batch = staffIds.slice(i, i + STAFF_BATCH);
          const params = new URLSearchParams();
          params.append("StartDate", startDate);
          params.append("EndDate", endDate);
          params.append("Limit", "200");
          params.append("Offset", "0");
          for (const id of batch) {
            params.append("StaffIds", id);
          }
          const url = `${MINDBODY_API_BASE}/appointment/staffappointments?${params.toString()}`;
          try {
            const r = await fetch(url, {
              method: "GET",
              headers: {
                "Api-Key": apiKey,
                SiteId: SANDBOX_SITE_ID,
                Authorization: `Bearer ${accessToken}`,
              },
            });
            const parsed = await readResponseSafely(r);
            const body = parsed.bodyJson as
              | { Appointments?: unknown[]; PaginationResponse?: unknown }
              | null;
            const apptCount = Array.isArray(body?.Appointments)
              ? body!.Appointments!.length
              : 0;
            const totalResults =
              body?.PaginationResponse &&
              typeof body.PaginationResponse === "object"
                ? (body.PaginationResponse as Record<string, unknown>)
                    .TotalResults
                : null;

            const batchSummary: Record<string, unknown> = {
              batchIndex: Math.floor(i / STAFF_BATCH),
              staffIdsRange: `${batch[0]}..${batch[batch.length - 1]}`,
              staffIdsCount: batch.length,
              status: parsed.status,
              ok: parsed.ok,
              apptCount,
              totalResults,
            };

            if (apptCount > 0 && Array.isArray(body?.Appointments)) {
              foundNonEmpty = true;
              batchSummary.firstAppointmentRaw = body.Appointments[0];
              batchSummary.secondAppointmentRaw =
                body.Appointments[1] ?? null;
              batchSummary.sampleKeys =
                typeof body.Appointments[0] === "object" &&
                body.Appointments[0] !== null
                  ? Object.keys(body.Appointments[0] as Record<string, unknown>)
                  : [];
              batchSummary.fullPaginationResponse = body.PaginationResponse;
            }

            (walkResults.batches as unknown[]).push(batchSummary);
          } catch (e) {
            (walkResults.batches as unknown[]).push({
              batchIndex: Math.floor(i / STAFF_BATCH),
              fetchError: e instanceof Error ? e.message : "unknown",
            });
          }
        }

        walkResults.foundNonEmpty = foundNonEmpty;
        results.step4_appointment_staff_walk = walkResults;

        // ── Step 5: List clients (the roster read).
        const clientsUrl = `${MINDBODY_API_BASE}/client/clients`;
        try {
          const r = await fetch(clientsUrl, {
            method: "GET",
            headers: {
              "Api-Key": apiKey,
              SiteId: SANDBOX_SITE_ID,
              Authorization: `Bearer ${accessToken}`,
            },
          });
          results.step5_client_clients = {
            url: clientsUrl,
            ...(await readResponseSafely(r)),
          };
        } catch (e) {
          results.step5_client_clients = {
            url: clientsUrl,
            fetchError: e instanceof Error ? e.message : "unknown",
          };
        }

        return jsonResp(200, results);
      },
    },
  },
});
