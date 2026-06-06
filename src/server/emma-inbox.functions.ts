/**
 * Emma(OS) patient-reply inbox (v359 — Promotions Engine Pillar 6 UI).
 *
 * The send-loop plumbing (v350-v354) captures every inbound row in
 * patient_outreach (direction='inbound'). Until now the spa had no
 * surface to read them. This module exposes:
 *
 *   listPatientInbox    — flat list of inbound rows joined with patient
 *                          + campaign + their immediate outbound parent
 *                          for thread context. Capped at 100, newest first.
 *   getInboxThread      — full conversation for one state row, ordered
 *                          chronologically (outbound + inbound interleaved).
 *   markInboxRead       — flips read_at on the inbound row. Note:
 *                          patient_outreach.read_at is dual-purpose:
 *                          on outbound rows it's the email-open signal
 *                          (set by v354 tracking webhooks), on inbound
 *                          rows it's "spa has seen this reply" — same
 *                          column, different semantic by direction.
 *
 * Scope notes:
 *   - Click events (channel='link') are signal, not conversation. They
 *     stay in Reports (v357) but don't appear in Inbox. Click=intent;
 *     a real patient reply is in 'sms' or 'email'.
 *   - STOP/UNSUBSCRIBE keyword auto-replies (v351) generate inbound
 *     rows with the keyword body. We include them with a clear
 *     'opted_out' badge so the spa sees who opted out via reply.
 *   - Auto-drafted reply composer is deferred. Karen handles SMS
 *     auto-response server-side; for v1 the inbox is read-only.
 *
 * Established 2026-05-16 (Promotions Engine v359 / Pillar 6 UI).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type InboxChannel = "sms" | "email";

export type InboxRow = {
  /** The inbound patient_outreach row id (the reply itself). */
  outreachId: string;
  /** The state row id — used as conversation key for the thread view. */
  stateId: string;
  channel: InboxChannel;
  body: string;
  subject: string | null;
  receivedAt: string;
  /** Null = unread; ISO = spa marked read. */
  readAt: string | null;
  /** True if this reply was a STOP/UNSUBSCRIBE keyword (opted_out signal). */
  optedOut: boolean;

  patientNodeId: string;
  patientName: string;
  patientPhone: string | null;
  patientEmail: string | null;

  campaignId: string | null;
  campaignTitle: string | null;

  /** The outbound message this reply answered (the most-recent outbound
   *  on this state row prior to the inbound). Null if we can't link one. */
  parentOutbound: {
    outreachId: string;
    channel: string;
    subject: string | null;
    body: string;
    sentAt: string | null;
  } | null;
};

export type InboxThreadMessage = {
  outreachId: string;
  direction: "outbound" | "inbound";
  channel: string;
  subject: string | null;
  body: string;
  at: string; // sent_at OR created_at, whichever is meaningful
  skipReason: string | null;
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

const listInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const threadInput = z.object({
  accessToken: z.string().min(1),
  stateId: z.string().uuid(),
  viewAsUserId: z.string().uuid().optional(),
});

const markReadInput = z.object({
  accessToken: z.string().min(1),
  outreachId: z.string().uuid(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

const STOP_PHRASES = [
  /\bstop\b/i,
  /\bstopall\b/i,
  /\bunsubscribe\b/i,
  /\bopt[- ]?out\b/i,
  /\bcancel\b/i,
  /\bremove\b/i,
];

function isOptOutKeyword(body: string): boolean {
  const firstWord = body.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout"].includes(firstWord)) {
    return true;
  }
  // Fallback: scan the first 200 chars for the phrase. We're not enforcing
  // — that's emma-optout's job — just flagging for the inbox badge.
  const head = body.slice(0, 200);
  return STOP_PHRASES.some((re) => re.test(head));
}

// ─── listPatientInbox ─────────────────────────────────────────────────────

export const listPatientInbox = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<InboxRow[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // 1) Pull the inbound rows (sms + email only — click events excluded).
    const { data: inbound, error } = await sb
      .from("patient_outreach")
      .select(
        "id, patient_outreach_state_id, channel, body, subject, sent_at, read_at, created_at",
      )
      .eq("user_id", effectiveUserId)
      .eq("direction", "inbound")
      .in("channel", ["sms", "email"])
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(`Couldn't load inbox: ${error.message}`);
    if (!inbound || inbound.length === 0) return [];

    // 2) Pull the state rows + patient + campaign for each. Batch the
    //    lookups by collecting unique ids first.
    const stateIds = Array.from(new Set(inbound.map((r) => r.patient_outreach_state_id)));
    const { data: states, error: sErr } = await sb
      .from("patient_outreach_state")
      .select("id, campaign_node_id, patient_node_id")
      .in("id", stateIds);
    if (sErr) throw new Error(`Couldn't load state rows: ${sErr.message}`);

    const stateById = new Map(states?.map((s) => [s.id, s]) ?? []);

    const patientIds = Array.from(
      new Set((states ?? []).map((s) => s.patient_node_id)),
    );
    const campaignIds = Array.from(
      new Set((states ?? []).map((s) => s.campaign_node_id)),
    );

    const [{ data: patients }, { data: campaigns }] = await Promise.all([
      sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .in("id", patientIds.length > 0 ? patientIds : [""]),
      sb
        .from("knowledge_nodes")
        .select("id, title")
        .in("id", campaignIds.length > 0 ? campaignIds : [""]),
    ]);

    const patientById = new Map(
      (patients ?? []).map((p) => [
        p.id,
        {
          title: p.title,
          phone:
            ((p.attachments as { phone?: string } | null)?.phone as
              | string
              | undefined) ?? null,
          email:
            ((p.attachments as { email?: string } | null)?.email as
              | string
              | undefined) ?? null,
        },
      ]),
    );
    const campaignById = new Map(
      (campaigns ?? []).map((c) => [c.id, c.title]),
    );

    // 3) Pull the most-recent outbound row for each state (the parent
    //    message this reply answered). One round-trip per state would
    //    be expensive — instead pull all outbound rows for these states
    //    once and reduce to "most recent per state" in JS.
    const { data: outbound } = await sb
      .from("patient_outreach")
      .select("id, patient_outreach_state_id, channel, subject, body, sent_at")
      .eq("user_id", effectiveUserId)
      .eq("direction", "outbound")
      .in("patient_outreach_state_id", stateIds)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false });

    const latestOutboundByState = new Map<
      string,
      {
        outreachId: string;
        channel: string;
        subject: string | null;
        body: string;
        sentAt: string | null;
      }
    >();
    for (const o of outbound ?? []) {
      if (!latestOutboundByState.has(o.patient_outreach_state_id)) {
        latestOutboundByState.set(o.patient_outreach_state_id, {
          outreachId: o.id,
          channel: o.channel,
          subject: o.subject,
          body: o.body,
          sentAt: o.sent_at,
        });
      }
    }

    // 4) Assemble
    const rows: InboxRow[] = inbound.map((r) => {
      const state = stateById.get(r.patient_outreach_state_id);
      const patient = state ? patientById.get(state.patient_node_id) : undefined;
      const campaignTitle = state
        ? campaignById.get(state.campaign_node_id) ?? null
        : null;
      const parent = latestOutboundByState.get(r.patient_outreach_state_id) ?? null;
      return {
        outreachId: r.id,
        stateId: r.patient_outreach_state_id,
        channel: r.channel as InboxChannel,
        body: r.body,
        subject: r.subject,
        receivedAt: r.sent_at ?? r.created_at,
        readAt: r.read_at,
        optedOut: isOptOutKeyword(r.body),
        patientNodeId: state?.patient_node_id ?? "",
        patientName: patient?.title ?? "Unknown patient",
        patientPhone: patient?.phone ?? null,
        patientEmail: patient?.email ?? null,
        campaignId: state?.campaign_node_id ?? null,
        campaignTitle,
        parentOutbound: parent,
      };
    });

    return rows;
  });

// ─── getInboxThread ───────────────────────────────────────────────────────

export const getInboxThread = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => threadInput.parse(input))
  .handler(async ({ data }): Promise<InboxThreadMessage[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: rows, error } = await sb
      .from("patient_outreach")
      .select(
        "id, direction, channel, subject, body, sent_at, created_at, skip_reason",
      )
      .eq("user_id", effectiveUserId)
      .eq("patient_outreach_state_id", data.stateId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Couldn't load thread: ${error.message}`);

    return (rows ?? []).map((r) => ({
      outreachId: r.id,
      direction: r.direction as "outbound" | "inbound",
      channel: r.channel,
      subject: r.subject,
      body: r.body,
      at: r.sent_at ?? r.created_at,
      skipReason: r.skip_reason,
    }));
  });

// ─── markInboxRead ────────────────────────────────────────────────────────

export const markInboxRead = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => markReadInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { error } = await sb
      .from("patient_outreach")
      .update({ read_at: new Date().toISOString() })
      .eq("id", data.outreachId)
      .eq("user_id", userId)
      .eq("direction", "inbound")
      .is("read_at", null); // Race-safe — first mark wins.
    if (error) throw new Error(`Couldn't mark as read: ${error.message}`);

    return { ok: true };
  });
