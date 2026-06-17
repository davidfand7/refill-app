/**
 * Emma(OS) per-spa sender domain management (v355).
 *
 * Replaces the EMMA_FROM_EMAIL global env var with a per-tenant verified
 * sender. The spa owner registers their domain ("rejuvmedical.com"),
 * publishes the DNS records Resend prescribes (SPF TXT + DKIM CNAMEs),
 * Resend confirms verification, send-time picks up the verified sender.
 *
 * Resend domain API surface we use:
 *   POST /domains              { name } → creates + returns records[]
 *   GET  /domains/:id          → status + records[]
 *   DELETE /domains/:id        → removes
 *
 * Authority of truth: Resend. We mirror status + dns_records into
 * emma_sender_domains so the UI doesn't hit Resend on every page load.
 * The Refresh button + send-time-when-pending re-read Resend and
 * update the local row.
 *
 * Spa-scoped via RLS (user_id = auth.uid()) plus a unique (user_id,
 * domain) constraint. Resend's account-level uniqueness on domain
 * name is enforced by Resend itself — we surface their error verbatim
 * if a spa tries to register a domain another tenant already owns.
 *
 * Established 2026-05-16 (Promotions Engine v355).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";

// ─── Public types exported to UI ──────────────────────────────────────────

export type DnsRecord = {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string | number | null;
  priority?: number | null;
  status?: string | null;
};

export type EmmaSenderDomain = {
  id: string;
  domain: string;
  fromLocalPart: string;
  fromDisplayName: string;
  resendDomainId: string | null;
  status: "pending" | "verified" | "failed";
  dnsRecords: DnsRecord[];
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Fully-rendered "<Name> <local@domain>" — what send-time will use if verified. */
  fromAddressPreview: string;
};

// ─── Admin client ─────────────────────────────────────────────────────────

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

// ─── Zod ──────────────────────────────────────────────────────────────────

const accessTokenOnly = z.object({
  accessToken: z.string().min(1),
});

// Plain-old domain matcher. We deliberately reject schemes/paths and
// require at least one dot — Resend rejects "localhost" anyway and we'd
// rather catch the typo here.
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const createInput = z.object({
  accessToken: z.string().min(1),
  domain: z.string().min(3).max(253).regex(DOMAIN_RE, "Invalid domain"),
  fromLocalPart: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._+-]+$/i, "Invalid local part")
    .optional(),
  fromDisplayName: z.string().min(1).max(80).optional(),
});

const updateInput = z.object({
  accessToken: z.string().min(1),
  id: z.string().uuid(),
  fromLocalPart: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._+-]+$/i)
    .optional(),
  fromDisplayName: z.string().min(1).max(80).optional(),
});

const idInput = z.object({
  accessToken: z.string().min(1),
  id: z.string().uuid(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function hydrate(row: Database["public"]["Tables"]["emma_sender_domains"]["Row"]): EmmaSenderDomain {
  const records = (row.dns_records as unknown as DnsRecord[] | null) ?? [];
  return {
    id: row.id,
    domain: row.domain,
    fromLocalPart: row.from_local_part,
    fromDisplayName: row.from_display_name,
    resendDomainId: row.resend_domain_id,
    status: row.status as EmmaSenderDomain["status"],
    dnsRecords: records,
    lastCheckedAt: row.last_checked_at,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fromAddressPreview: `${row.from_display_name} <${row.from_local_part}@${row.domain}>`,
  };
}

function resendKey(): string {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not configured on the server.");
  return key;
}

type ResendDomainRecord = {
  record?: string;
  name?: string;
  type?: string;
  value?: string;
  ttl?: string | number | null;
  priority?: number | null;
  status?: string | null;
};

type ResendDomainResponse = {
  id?: string;
  name?: string;
  status?: string;
  records?: ResendDomainRecord[];
};

async function resendFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${resendKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

function normalizeRecords(records: ResendDomainRecord[] | undefined): DnsRecord[] {
  if (!Array.isArray(records)) return [];
  return records.map((r) => ({
    record: String(r.record ?? r.type ?? ""),
    name: String(r.name ?? ""),
    type: String(r.type ?? ""),
    value: String(r.value ?? ""),
    ttl: r.ttl ?? null,
    priority: r.priority ?? null,
    status: r.status ?? null,
  }));
}

function mapStatus(s: string | undefined): "pending" | "verified" | "failed" {
  // Resend statuses observed in the wild: 'not_started', 'pending',
  // 'verified', 'failure', 'temporary_failure'. Collapse to our three.
  const v = (s ?? "").toLowerCase();
  if (v === "verified") return "verified";
  if (v.includes("fail")) return "failed";
  return "pending";
}

// ─── listSenderDomains ────────────────────────────────────────────────────

export const listSenderDomains = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => accessTokenOnly.parse(input))
  .handler(async ({ data }): Promise<EmmaSenderDomain[]> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const { data: rows, error } = await sb
      .from("emma_sender_domains")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Couldn't list sender domains: ${error.message}`);
    return (rows ?? []).map(hydrate);
  });

// ─── createSenderDomain ───────────────────────────────────────────────────

export const createSenderDomain = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createInput.parse(input))
  .handler(async ({ data }): Promise<EmmaSenderDomain> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Resend first. If they reject, we don't persist anything.
    const domain = data.domain.trim().toLowerCase();
    const resp = (await resendFetch("/domains", {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    })) as ResendDomainResponse | null;

    if (!resp || typeof resp.id !== "string") {
      throw new Error("Resend didn't return a domain id — try again or contact support.");
    }

    const records = normalizeRecords(resp.records);
    const status = mapStatus(resp.status);

    const { data: row, error } = await sb
      .from("emma_sender_domains")
      .insert({
        user_id: userId,
        domain,
        from_local_part: data.fromLocalPart ?? "hello",
        from_display_name: data.fromDisplayName ?? "SmartSpa",
        resend_domain_id: resp.id,
        status,
        dns_records: records as unknown as Json,
        last_checked_at: new Date().toISOString(),
        verified_at: status === "verified" ? new Date().toISOString() : null,
      })
      .select("*")
      .single();

    if (error) {
      // Roll back the Resend side if we couldn't persist. Best-effort —
      // a Resend orphan is recoverable later from their dashboard.
      await resendFetch(`/domains/${resp.id}`, { method: "DELETE" }).catch(() => {});
      throw new Error(`Couldn't save sender domain: ${error.message}`);
    }

    return hydrate(row);
  });

// ─── refreshSenderDomain ──────────────────────────────────────────────────

export const refreshSenderDomain = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => idInput.parse(input))
  .handler(async ({ data }): Promise<EmmaSenderDomain> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: row, error } = await sb
      .from("emma_sender_domains")
      .select("*")
      .eq("user_id", userId)
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(`Couldn't load sender domain: ${error.message}`);
    if (!row) throw new Error("Sender domain not found.");
    if (!row.resend_domain_id) {
      throw new Error("Sender domain has no Resend id — please remove and re-add.");
    }

    // Ask Resend to re-check (POST /domains/:id/verify) and then read state.
    await resendFetch(`/domains/${row.resend_domain_id}/verify`, {
      method: "POST",
    }).catch(() => {
      // Some Resend states reject re-verify (already verified, etc.) —
      // that's fine, we still read the GET below.
    });
    const resp = (await resendFetch(`/domains/${row.resend_domain_id}`)) as
      | ResendDomainResponse
      | null;
    if (!resp || typeof resp.id !== "string") {
      throw new Error("Resend didn't return the domain — try again in a moment.");
    }

    const records = normalizeRecords(resp.records);
    const status = mapStatus(resp.status);
    const wasVerified = row.status === "verified";
    const nowVerified = status === "verified";

    const { data: updated, error: upErr } = await sb
      .from("emma_sender_domains")
      .update({
        status,
        dns_records: records as unknown as Json,
        last_checked_at: new Date().toISOString(),
        verified_at: nowVerified
          ? row.verified_at ?? new Date().toISOString()
          : wasVerified
            ? row.verified_at
            : null,
      })
      .eq("id", row.id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (upErr || !updated) {
      throw new Error(`Couldn't update sender domain: ${upErr?.message ?? "no row"}`);
    }
    return hydrate(updated);
  });

// ─── updateSenderDomain (display name / local part) ──────────────────────

export const updateSenderDomain = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateInput.parse(input))
  .handler(async ({ data }): Promise<EmmaSenderDomain> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const patch: Database["public"]["Tables"]["emma_sender_domains"]["Update"] = {};
    if (data.fromLocalPart) patch.from_local_part = data.fromLocalPart;
    if (data.fromDisplayName) patch.from_display_name = data.fromDisplayName;
    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update.");
    }

    const { data: row, error } = await sb
      .from("emma_sender_domains")
      .update(patch)
      .eq("id", data.id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error || !row) throw new Error(`Couldn't update sender: ${error?.message ?? "no row"}`);
    return hydrate(row);
  });

// ─── deleteSenderDomain ───────────────────────────────────────────────────

export const deleteSenderDomain = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => idInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: row, error } = await sb
      .from("emma_sender_domains")
      .select("resend_domain_id")
      .eq("user_id", userId)
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(`Couldn't load sender domain: ${error.message}`);
    if (!row) return { ok: true };

    if (row.resend_domain_id) {
      // Best-effort. If Resend errors (404, already gone), we still
      // delete the local row — leaving an orphan in our DB is worse
      // than leaving one in Resend.
      await resendFetch(`/domains/${row.resend_domain_id}`, {
        method: "DELETE",
      }).catch(() => {});
    }

    const { error: delErr } = await sb
      .from("emma_sender_domains")
      .delete()
      .eq("user_id", userId)
      .eq("id", data.id);
    if (delErr) throw new Error(`Couldn't remove sender: ${delErr.message}`);
    return { ok: true };
  });

// ─── Send-time resolver (server-internal, not a TanStack server fn) ─────

/**
 * Resolve the From address to use when Emma sends email FOR this spa.
 *
 * Order of precedence:
 *   1. spa's verified emma_sender_domains row (most recent verified)
 *   2. process.env.EMMA_FROM_EMAIL
 *   3. Refill platform default "Refill <hello@getrefill.app>"
 *      (only when REFILL_FROM_ENABLED=1 — see scan-followup.ts gating)
 *   4. legacy platform default "Emma <hello@notify.openagentic.site>"
 *
 * Called by emma-blast.functions.ts:sendCampaignMessage. Pure function
 * over a userId — no auth check here because the caller has already
 * verified auth and is acting on the row they own.
 *
 * Phase 0 (2026-05-19): the Refill platform default kicks in for spas
 * who haven't set up their own verified sender domain. Karen already has
 * her own verified sender — she's unaffected by the gating flip. The
 * REFILL_FROM_ENABLED flag stays off until SPF/DKIM/DMARC on
 * getrefill.app + Gmail tabs placement is verified per the arch doc.
 */
export async function resolveSpaFromEmail(userId: string): Promise<string> {
  const sb = admin();
  const { data: rows } = await sb
    .from("emma_sender_domains")
    .select("from_display_name, from_local_part, domain")
    .eq("user_id", userId)
    .eq("status", "verified")
    .order("verified_at", { ascending: false })
    .limit(1);
  const row = rows?.[0];
  if (row) {
    return `${row.from_display_name} <${row.from_local_part}@${row.domain}>`;
  }
  if (process.env.EMMA_FROM_EMAIL) {
    return process.env.EMMA_FROM_EMAIL;
  }
  if (process.env.REFILL_FROM_ENABLED === "1") {
    return "Refill <hello@getrefill.app>";
  }
  return "SmartSpa <hello@notify.openagentic.site>";
}
