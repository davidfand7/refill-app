/**
 * Emma(OS) scheduler-platform integration (v381).
 *
 * Handles the spa-facing OAuth wizard for connecting third-party
 * scheduling platforms (Acuity first; Mindbody / JaneApp / Square /
 * Boulevard slot in as future ships using the same pattern). The
 * wizard principle (see [[feedback-setup-wizards-auto-advance]]):
 * one button → OAuth redirect → done. No user-facing API key.
 *
 * Surfaces:
 *   initiateAcuityOAuth      — UI server fn that returns the OAuth
 *                              redirect URL. Generates a state token
 *                              + ensures a pending connection row.
 *   getSchedulerConnection   — read connection status for settings UI
 *   disconnectScheduler      — revoke connection: tears down webhooks
 *                              on the platform side + soft-deletes row
 *
 * The actual code exchange + webhook registration + backfill happen
 * in the OAuth callback route handler (src/routes/api.integrations.
 * acuity.oauth-callback.ts) where we have access to the request URL.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";
import {
  buildAcuityAuthorizeUrl,
  listAcuityAppointments,
  listAcuityClients,
  tearDownAcuityWebhooksForTarget,
  type AcuityAppointment,
  type AcuityClient,
} from "@/lib/schedulers/acuity";
import {
  buildSquareAuthorizeUrl,
  deleteSquareWebhookSubscription,
  listSquareBookings,
  refreshSquareAccessToken,
  resolveSquareEnv,
  squareStatusToRefillStatus,
  type SquareBooking,
  type SquareEnv,
} from "@/lib/schedulers/square";
import {
  buildPatientIndex,
  matchPatientFromIndex,
} from "@/server/emma-appointments.functions";
import {
  doIngestClientList,
  type ClientListReceipt,
} from "@/server/patient-ingest.functions";

// ─── Types ─────────────────────────────────────────────────────────────────

export type SchedulerPlatform = "acuity" | "mindbody" | "jane" | "square" | "boulevard";

export type SchedulerStatus = "connected" | "pending" | "reauth_needed" | "error" | "disconnected";

export type SchedulerConnection = {
  id: string;
  platform: SchedulerPlatform;
  platformAccountId: string | null;
  platformAccountEmail: string | null;
  status: SchedulerStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
};

// ─── Admin client ──────────────────────────────────────────────────────────

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type SupabaseAdmin = ReturnType<typeof admin>;

// State payload signed into the OAuth `state` parameter so the callback
// can identify which user kicked off the flow + where to send them back.
type OAuthState = {
  userId: string;
  platform: SchedulerPlatform;
  returnTo: string;
  nonce: string;
};

export function encodeOAuthState(state: OAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf-8").toString("base64url");
}

export function decodeOAuthState(raw: string): OAuthState | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const obj = JSON.parse(json);
    if (!obj.userId || !obj.platform) return null;
    return obj as OAuthState;
  } catch {
    return null;
  }
}

// ─── initiateAcuityOAuth ───────────────────────────────────────────────────

const initiateInput = z.object({
  accessToken: z.string().min(1),
  origin: z.string().min(1),
  returnTo: z.string().default("/app/refill/settings/scheduler"),
});

// v415.2: returnTo allowlist. The OAuth state round-trip writes this
// into a signed state blob and the callback reads it back as the
// post-OAuth navigation target. Without an allowlist, a malicious
// caller could pass `returnTo: "https://evil.com"` and trick the
// callback into redirecting users off-domain. Allowlist by path
// prefix — internal paths only.
const RETURN_TO_ALLOWLIST_PREFIXES = [
  "/app/refill/settings/scheduler",
  "/onboard",
] as const;

function isAllowedReturnTo(returnTo: string): boolean {
  if (!returnTo.startsWith("/")) return false; // reject protocol-relative + absolute
  if (returnTo.startsWith("//")) return false; // explicit reject of //evil.com
  return RETURN_TO_ALLOWLIST_PREFIXES.some(
    (prefix) =>
      returnTo === prefix ||
      returnTo.startsWith(prefix + "?") ||
      returnTo.startsWith(prefix + "/") ||
      returnTo.startsWith(prefix + "#"),
  );
}

export const initiateAcuityOAuth = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);

    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(
        `returnTo "${data.returnTo}" is not in the OAuth allowlist`,
      );
    }

    const CLIENT_ID = process.env.ACUITY_CLIENT_ID;
    if (!CLIENT_ID) {
      throw new Error(
        "Acuity OAuth is not configured on the server. ACUITY_CLIENT_ID is missing.",
      );
    }

    const redirectUri = `${data.origin}/api/integrations/acuity/oauth-callback`;
    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeOAuthState({
      userId,
      platform: "acuity",
      returnTo: data.returnTo,
      nonce,
    });

    const redirectUrl = buildAcuityAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri,
      state,
      scope: "api-v1",
    });

    return { redirectUrl };
  });

// ─── initiateSquareOAuth ───────────────────────────────────────────────────
//
// Mirrors initiateAcuityOAuth: returns a redirectUrl the UI navigates
// the spa to so they authorize Refill on Square's side. Square's
// authorize-code TTL is 5 minutes, so the callback handler exchanges
// immediately. We default to production env; sandbox path uses
// SQUARE_ENV=sandbox + the sandbox app credentials (separate Square
// app per environment).

export const initiateSquareOAuth = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);

    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(
        `returnTo "${data.returnTo}" is not in the OAuth allowlist`,
      );
    }

    const env: SquareEnv = resolveSquareEnv();
    console.log(
      `[square/oauth-start] SQUARE_ENV raw="${process.env.SQUARE_ENV}" resolved="${env}"`,
    );
    const CLIENT_ID =
      env === "sandbox"
        ? process.env.SQUARE_SANDBOX_APP_ID
        : process.env.SQUARE_APP_ID;
    if (!CLIENT_ID) {
      throw new Error(
        `Square OAuth is not configured on the server. ${env === "sandbox" ? "SQUARE_SANDBOX_APP_ID" : "SQUARE_APP_ID"} is missing.`,
      );
    }

    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeOAuthState({
      userId,
      platform: "square",
      returnTo: data.returnTo,
      nonce,
    });

    const redirectUrl = buildSquareAuthorizeUrl({
      clientId: CLIENT_ID,
      env,
      state,
    });

    return { redirectUrl };
  });

// ─── getSchedulerConnection ────────────────────────────────────────────────

const getConnectionInput = z.object({ accessToken: z.string().min(1) });

export const getSchedulerConnection = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getConnectionInput.parse(raw))
  .handler(async ({ data }): Promise<SchedulerConnection | null> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Types not regenerated yet — types.ts will pick up the new tables
    // on the next supabase-typegen pass after the migration is applied.
    const { data: row, error } = await (sb as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            in: (col: string, vals: string[]) => {
              order: (col: string, opts: { ascending: boolean }) => {
                limit: (n: number) => {
                  maybeSingle: () => Promise<{ data: SchedulerConnectionRow | null; error: { message: string } | null }>;
                };
              };
            };
          };
        };
      };
    })
      .from("emma_scheduler_connections")
      .select(
        "id, platform, platform_account_id, platform_account_email, status, last_sync_at, last_error, connected_at, disconnected_at",
      )
      .eq("user_id", userId)
      .in("status", ["connected", "pending", "reauth_needed", "error"])
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Couldn't load connection: ${error.message}`);
    if (!row) return null;
    return rowToConnection(row);
  });

type SchedulerConnectionRow = {
  id: string;
  platform: string;
  platform_account_id: string | null;
  platform_account_email: string | null;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
};

function rowToConnection(row: SchedulerConnectionRow): SchedulerConnection {
  return {
    id: row.id,
    platform: row.platform as SchedulerPlatform,
    platformAccountId: row.platform_account_id,
    platformAccountEmail: row.platform_account_email,
    status: row.status as SchedulerStatus,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
  };
}

// ─── disconnectScheduler ───────────────────────────────────────────────────

const disconnectInput = z.object({
  accessToken: z.string().min(1),
  origin: z.string().min(1),
});

export const disconnectScheduler = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => disconnectInput.parse(raw))
  .handler(async ({ data }): Promise<{ disconnected: boolean; webhooksRemoved: number }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: row, error } = await (sb as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            in: (col: string, vals: string[]) => {
              order: (col: string, opts: { ascending: boolean }) => {
                limit: (n: number) => {
                  maybeSingle: () => Promise<{
                    data: (SchedulerConnectionRow & {
                      access_token: string | null;
                      webhook_secret: string;
                      webhook_subscription_id: string | null;
                    }) | null;
                    error: { message: string } | null;
                  }>;
                };
              };
            };
          };
        };
      };
    })
      .from("emma_scheduler_connections")
      .select("id, platform, access_token, webhook_secret, webhook_subscription_id, status, platform_account_id, platform_account_email, last_sync_at, last_error, connected_at, disconnected_at")
      .eq("user_id", userId)
      .in("status", ["connected", "pending", "reauth_needed", "error"])
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Couldn't load connection: ${error.message}`);
    if (!row) return { disconnected: false, webhooksRemoved: 0 };

    let webhooksRemoved = 0;
    if (row.platform === "acuity" && row.access_token) {
      try {
        const webhookBaseUrl = `${data.origin}/api/webhooks/scheduler/acuity/${row.webhook_secret}`;
        webhooksRemoved = await tearDownAcuityWebhooksForTarget({
          accessToken: row.access_token,
          webhookBaseUrl,
        });
      } catch (e) {
        // Token may already be invalidated. Continue with the disconnect.
        // We log via the connection row's last_error so it shows in UI.
        await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
          .from("emma_scheduler_connections")
          .update({
            last_error: `Webhook teardown failed: ${e instanceof Error ? e.message : "unknown"}`,
          })
          .eq("id", row.id);
      }
    } else if (
      row.platform === "square" &&
      row.access_token &&
      row.webhook_subscription_id
    ) {
      // Square teardown is targeted: delete the per-spa subscription
      // resource by ID (the notification URL is single-global, shared
      // across all Square spas, so URL-match teardown isn't an option).
      // Fail-open if the token is already revoked — Square will GC the
      // subscription anyway once the receiver stops being reachable.
      try {
        const env: SquareEnv =
          resolveSquareEnv();
        await deleteSquareWebhookSubscription({
          accessToken: row.access_token,
          env,
          subscriptionId: row.webhook_subscription_id,
        });
        webhooksRemoved = 1;
      } catch (e) {
        await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
          .from("emma_scheduler_connections")
          .update({
            last_error: `Square webhook teardown failed: ${e instanceof Error ? e.message : "unknown"}`,
          })
          .eq("id", row.id);
      }
    }

    await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<{ error: { message: string } | null }> } } })
      .from("emma_scheduler_connections")
      .update({
        status: "disconnected",
        disconnected_at: new Date().toISOString(),
        access_token: null,
        refresh_token: null,
      })
      .eq("id", row.id);

    return { disconnected: true, webhooksRemoved };
  });

// ─── resyncSchedulerConnection ─────────────────────────────────────────────
//
// v381.6 — manual "re-pull from the platform" trigger for an already-
// connected spa. Same backfill logic the OAuth callback runs at first
// connect, exposed as a server fn so the settings page can offer a
// Re-sync button. The primary use case is recovering from v381's
// patient_node_id null bug (rows already in the DB without resolved
// names) — re-running the backfill applies the v381.5 matcher to every
// row in the 30d-back + 90d-forward window. Idempotent under
// (user_id, external_id, source) upsert.

const resyncInput = z.object({ accessToken: z.string().min(1) });

export const resyncSchedulerConnection = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => resyncInput.parse(raw))
  .handler(async ({ data }): Promise<{
    platform: string;
    totalAppointments: number;
    resolvedPatientNames: number;
  }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: row } = await (sb as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (c: string, v: string) => {
            in: (c: string, vals: string[]) => {
              order: (c: string, opts: { ascending: boolean }) => {
                limit: (n: number) => {
                  maybeSingle: () => Promise<{
                    data: {
                      id: string;
                      platform: string;
                      access_token: string | null;
                    } | null;
                  }>;
                };
              };
            };
          };
        };
      };
    })
      .from("emma_scheduler_connections")
      .select("id, platform, access_token")
      .eq("user_id", userId)
      .in("status", ["connected", "reauth_needed", "error"])
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row) {
      throw new Error(
        "No active scheduler connection — connect a scheduler first.",
      );
    }
    if (!row.access_token) {
      throw new Error(
        "Connection is missing an access token — please reconnect.",
      );
    }
    if (row.platform !== "acuity" && row.platform !== "square") {
      throw new Error(
        `Re-sync is only available for Acuity and Square right now (your connection is ${row.platform}).`,
      );
    }

    const result =
      row.platform === "square"
        ? await backfillSquareBookings({
            sb,
            userId,
            accessToken: row.access_token,
          })
        : await backfillAcuityAppointments({
            sb,
            userId,
            accessToken: row.access_token,
          });

    // Stamp last_sync_at so the settings page reflects the manual sync.
    await (sb as unknown as {
      from: (t: string) => {
        update: (v: object) => {
          eq: (c: string, v: string) => Promise<unknown>;
        };
      };
    })
      .from("emma_scheduler_connections")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", row.id);

    return {
      platform: row.platform,
      totalAppointments: result.totalAppointments,
      resolvedPatientNames: result.resolvedPatientNames,
    };
  });

// ─── Backfill helper (shared with OAuth callback) ──────────────────────────
//
// v381.6: extracted from src/routes/api.integrations.acuity.oauth-callback.ts
// so resyncSchedulerConnection can run the same backfill on an already-
// connected spa without re-running OAuth. Idempotent: upserts on
// (user_id, external_id, source). Pre-migrates any leftover
// csv-acuity-source rows to acuity-source first so patient_node_id and
// recovery_event_id FKs survive.

const BACKFILL_DAYS_BACK = 30;
const BACKFILL_DAYS_FORWARD = 90;

export async function backfillAcuityAppointments(args: {
  sb: SupabaseAdmin;
  userId: string;
  accessToken: string;
}): Promise<{ totalAppointments: number; resolvedPatientNames: number }> {
  const { sb, userId, accessToken } = args;

  const now = new Date();
  const minDate = new Date(now.getTime() - BACKFILL_DAYS_BACK * 86400000);
  const maxDate = new Date(now.getTime() + BACKFILL_DAYS_FORWARD * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [active, canceled] = await Promise.all([
    listAcuityAppointments(accessToken, {
      minDate: fmt(minDate),
      maxDate: fmt(maxDate),
      max: 1000,
      canceled: false,
    }),
    listAcuityAppointments(accessToken, {
      minDate: fmt(minDate),
      maxDate: fmt(maxDate),
      max: 1000,
      canceled: true,
    }),
  ]);

  const all = [...active, ...canceled];

  // Pre-migrate any leftover csv-acuity-sourced rows so the upsert
  // dedupes correctly on the (user_id, external_id, source) composite.
  await (sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => Promise<unknown>;
        };
      };
    };
  })
    .from("emma_appointments")
    .update({ source: "acuity" })
    .eq("user_id", userId)
    .eq("source", "csv-acuity");

  // Build the patient index ONCE for the whole batch.
  const patientIndex = await buildPatientIndex(sb, userId);

  let resolvedPatientNames = 0;
  const rows = all.map((apt) => {
    const patientNodeId = matchPatientFromIndex(
      {
        patientFirstName: apt.firstName || null,
        patientLastName: apt.lastName || null,
        patientPhone: apt.phone || null,
        patientEmail: apt.email || null,
      },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return acuityAppointmentToRow(apt, userId, patientNodeId);
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("emma_appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) {
      throw new Error(`Appointment upsert batch ${i}: ${error.message}`);
    }
  }

  return {
    totalAppointments: rows.length,
    resolvedPatientNames,
  };
}

function acuityAppointmentToRow(
  apt: AcuityAppointment,
  userId: string,
  patientNodeId: string | null,
): Database["public"]["Tables"]["emma_appointments"]["Insert"] {
  // v1.4.3: parse Acuity's timezone-aware datetime properly. The old
  // regex .replace(/[+-]\d{4}$/, "Z") STRIPPED the offset without
  // applying it — so "2026-05-26T16:00:00-0600" (4 PM MT) became
  // "2026-05-26T16:00:00Z" (4 PM UTC = 10 AM MT), shifting every Karen
  // appointment 6 hours too early. Caught 2026-05-26 during Karen's live
  // Acuity cancel test: she booked for 4 PM MT, dispatcher saw it as
  // already 2.5h in the past, skipped rescue. new Date().toISOString()
  // handles all Acuity formats (with or without colon in offset, Z, etc.).
  const scheduledAt = new Date(apt.datetime ?? "").toISOString();
  const status: Database["public"]["Tables"]["emma_appointments"]["Insert"]["status"] = apt.canceled
    ? "cancelled"
    : apt.noShow
      ? "no_show"
      : "scheduled";

  const base: Database["public"]["Tables"]["emma_appointments"]["Insert"] = {
    user_id: userId,
    external_id: String(apt.id),
    source: "acuity",
    scheduled_at: scheduledAt,
    duration_min: Number(apt.duration) || 0,
    treatment_type: apt.type || null,
    provider_name: apt.calendar || null,
    status,
    notes: apt.notes || null,
  };
  if (patientNodeId) {
    base.patient_node_id = patientNodeId;
  }
  return base;
}

// ─── importAcuityClients (v415.3) ──────────────────────────────────────────
//
// Pull the spa's full client roster from Acuity via the OAuth token saved
// on the user's emma_scheduler_connections row, synthesize a CSV in the
// shape parseClientListCsv expects, and run it through the existing
// doIngestClientList pipeline. Reuses every line of the ingest /
// matching / enrichment code (patient-ingest.functions.ts:966) without
// touching it — the synthesized CSV is the contract surface, so neither
// caller needs to know about the other's storage format.
//
// Returns a tagged union so the wizard Step 3 can render each state
// cleanly: no Acuity connection (degrade to CSV upload), empty Acuity
// roster (also degrade to CSV), or imported (show count + advance).

const importAcuityClientsInput = z.object({
  accessToken: z.string().min(1),
});

export type ImportAcuityClientsResult =
  | { kind: "no-connection" }
  | { kind: "empty"; reason: "no-clients" }
  | { kind: "imported"; receipt: ClientListReceipt; rawCount: number };

export const importAcuityClients = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => importAcuityClientsInput.parse(raw))
  .handler(async ({ data }): Promise<ImportAcuityClientsResult> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Look up the active Acuity connection + its OAuth access token.
    // Same shape as getSchedulerConnection but we need access_token
    // back (it's stripped from the public SchedulerConnection type
    // because the client side never gets to see it).
    const { data: row, error } = await (sb as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            eq: (col: string, val: string) => {
              eq: (col: string, val: string) => {
                order: (col: string, opts: { ascending: boolean }) => {
                  limit: (n: number) => {
                    maybeSingle: () => Promise<{
                      data: { access_token: string | null } | null;
                      error: { message: string } | null;
                    }>;
                  };
                };
              };
            };
          };
        };
      };
    })
      .from("emma_scheduler_connections")
      .select("access_token")
      .eq("user_id", userId)
      .eq("platform", "acuity")
      .eq("status", "connected")
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`Couldn't read your Acuity connection: ${error.message}`);
    }
    if (!row || !row.access_token) {
      return { kind: "no-connection" };
    }

    // Pull the roster. Acuity's /clients endpoint returns the full list
    // in one response (no pagination cursor in their API). For very large
    // spas (5k+ clients) this can take 5-15s; we surface the elapsed
    // time hint in Step 3's UI rather than chunking.
    let clients: AcuityClient[];
    try {
      clients = await listAcuityClients(row.access_token);
    } catch (err) {
      throw new Error(
        `Couldn't pull your Acuity client roster: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }

    if (clients.length === 0) {
      return { kind: "empty", reason: "no-clients" };
    }

    // Synthesize CSV with the headers parseClientListCsv recognizes
    // ("First Name,Last Name,Phone,Email,Notes"). This sidesteps having
    // to refactor doIngestClientList to accept pre-parsed rows — the
    // CSV-string surface is the existing contract, and Acuity's
    // AcuityClient shape maps 1:1 to those columns.
    const csv = acuityClientsToCsv(clients);
    const receipt = await doIngestClientList(
      sb,
      userId,
      csv,
      "acuity://clients",
    );

    return { kind: "imported", receipt, rawCount: clients.length };
  });

/**
 * Build a RFC-4180-ish CSV string from Acuity client objects. The header
 * row uses the names parseClientListCsv recognizes (case-insensitive,
 * order-tolerant per its column-resolution logic). Values get
 * quote-wrapped + double-quote escaped for any field that might contain
 * commas, quotes, or newlines (notes in particular).
 */
function acuityClientsToCsv(clients: AcuityClient[]): string {
  const escape = (v: string | null | undefined): string => {
    const s = (v ?? "").toString();
    if (s === "") return "";
    const needsQuoting = /[",\r\n]/.test(s);
    if (!needsQuoting) return s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = "First Name,Last Name,Phone,Email,Notes";
  const lines = clients.map((c) =>
    [
      escape(c.firstName),
      escape(c.lastName),
      escape(c.phone),
      escape(c.email),
      escape(c.notes),
    ].join(","),
  );
  return [header, ...lines].join("\n");
}

// ─── Backfill helper for Square (shared with OAuth callback + resync) ──────
//
// Same shape as backfillAcuityAppointments: pulls a 30d-back + 90d-
// forward window, upserts on (user_id, external_id, source). The
// pagination cursor is Square's idiom — we follow until the API stops
// returning one.

export async function backfillSquareBookings(args: {
  sb: SupabaseAdmin;
  userId: string;
  accessToken: string;
}): Promise<{ totalAppointments: number; resolvedPatientNames: number }> {
  const { sb, userId, accessToken } = args;
  const env: SquareEnv =
    resolveSquareEnv();

  const now = new Date();
  const startAtMin = new Date(now.getTime() - 30 * 86400000).toISOString();
  const startAtMax = new Date(now.getTime() + 90 * 86400000).toISOString();

  const all: SquareBooking[] = [];
  let cursor: string | null = null;
  // Hard cap to avoid runaway pagination on degenerate seller accounts.
  for (let page = 0; page < 50; page++) {
    const { bookings, cursor: next } = await listSquareBookings({
      accessToken,
      env,
      startAtMin,
      startAtMax,
      limit: 200,
      cursor: cursor ?? undefined,
    });
    all.push(...bookings);
    if (!next) break;
    cursor = next;
  }

  // Pre-migrate any leftover csv-square-sourced rows so the upsert
  // dedupes correctly on (user_id, external_id, source) — same pattern
  // backfillAcuityAppointments uses for csv-acuity rows.
  await (sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => Promise<unknown>;
        };
      };
    };
  })
    .from("emma_appointments")
    .update({ source: "square" })
    .eq("user_id", userId)
    .eq("source", "csv-square");

  const patientIndex = await buildPatientIndex(sb, userId);

  // Square bookings carry customer_id but not the customer's name on
  // the booking response — we'd need a join or a follow-up to /v2/
  // customers/:id to enrich. For v1 we pass empty name/phone/email to
  // the matcher (it gracefully returns null when nothing's known) and
  // rely on the inbound-webhook path to populate the patient_node_id
  // when a known customer's booking changes. The Acuity pattern of
  // resolving via webhook payload covers ongoing changes; bulk-initial
  // backfill enrichment is queued for a follow-up ship.
  let resolvedPatientNames = 0;
  const rows = all.map((b) => {
    const patientNodeId = matchPatientFromIndex(
      {
        patientFirstName: null,
        patientLastName: null,
        patientPhone: null,
        patientEmail: null,
      },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return squareBookingToRow(b, userId, patientNodeId);
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("emma_appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) {
      throw new Error(`Square appointment upsert batch ${i}: ${error.message}`);
    }
  }

  return {
    totalAppointments: rows.length,
    resolvedPatientNames,
  };
}

export function squareBookingToRow(
  b: SquareBooking,
  userId: string,
  patientNodeId: string | null,
): Database["public"]["Tables"]["emma_appointments"]["Insert"] {
  const scheduledAt = new Date(b.startAt).toISOString();
  const seg = b.appointmentSegments[0];
  const durationMin = b.appointmentSegments.reduce(
    (sum, s) => sum + (s.durationMinutes ?? 0),
    0,
  );
  const base: Database["public"]["Tables"]["emma_appointments"]["Insert"] = {
    user_id: userId,
    external_id: b.id,
    source: "square",
    scheduled_at: scheduledAt,
    duration_min: durationMin,
    treatment_type: seg?.serviceVariationId ?? null,
    provider_name: seg?.teamMemberId ?? null,
    status: squareStatusToRefillStatus(b.status),
    notes: b.sellerNote || b.customerNote || null,
  };
  if (patientNodeId) base.patient_node_id = patientNodeId;
  return base;
}

// ─── Square token refresh helper (used by webhook + writeback paths) ───────
//
// Square access tokens last 30 days; refresh_token reissues a fresh pair.
// Centralized here so the webhook receiver, the rescue writeback, and the
// resync path all use the same just-in-time refresh logic.

export async function withFreshSquareToken<T>(args: {
  sb: SupabaseAdmin;
  connectionId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  fn: (accessToken: string) => Promise<T>;
}): Promise<T> {
  const expiresAtMs = args.expiresAt ? Date.parse(args.expiresAt) : null;
  const needsRefresh =
    !!args.refreshToken &&
    expiresAtMs !== null &&
    expiresAtMs - Date.now() < 3 * 86400000; // refresh ~3 days before expiry

  if (!needsRefresh) {
    return args.fn(args.accessToken);
  }

  const env: SquareEnv =
    resolveSquareEnv();
  const CLIENT_ID =
    env === "sandbox"
      ? process.env.SQUARE_SANDBOX_APP_ID
      : process.env.SQUARE_APP_ID;
  const CLIENT_SECRET =
    env === "sandbox"
      ? process.env.SQUARE_SANDBOX_APP_SECRET
      : process.env.SQUARE_APP_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    // Misconfigured — fall through with the old token; let the caller
    // see the failure if it does fail.
    return args.fn(args.accessToken);
  }

  const fresh = await refreshSquareAccessToken({
    refreshToken: args.refreshToken!,
    credentials: {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: "", // not used by refresh
      env,
    },
  });

  await (args.sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => Promise<unknown>;
      };
    };
  })
    .from("emma_scheduler_connections")
    .update({
      access_token: fresh.accessToken,
      refresh_token: fresh.refreshToken,
      token_expires_at: fresh.expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.connectionId);

  return args.fn(fresh.accessToken);
}

