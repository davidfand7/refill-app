/**
 * Refill manual-onboarding intake (v372).
 *
 * Captures spa owners who clicked "Set up Refill for my spa" — saves to
 * csv_scanner_leads (re-using the leads pipeline; an intent + a prior scan
 * can coexist on one row when emails match, otherwise an intent-only row
 * is inserted). Fires a notification email to Karen + David per intent so
 * manual onboarding can begin within 24 hours.
 *
 * Why no in-app self-serve onboarding yet: Refill's full configure-your-
 * spa flow ships once we have ~5 paying pilots and know the actual setup
 * pattern. Until then, manual onboarding by Karen + David is faster AND
 * better than a half-baked self-serve. This intake is the bridge.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";

// Phase 0 (2026-05-19): per the Refill-Standalone-Architecture risk register,
// hello@getrefill.app only goes live once SPF/DKIM/DMARC verifies + Gmail
// "tabs" placement is confirmed. REFILL_FROM_ENABLED gates the flip; default
// off preserves the existing notify.openagentic.site sender that's already
// warmed up.
const LEGACY_FROM_MAILBOX =
  process.env.SCAN_FOLLOWUP_MAILBOX ?? "hello@notify.openagentic.site";
const REFILL_FROM_MAILBOX =
  process.env.REFILL_FROM_MAILBOX ?? "hello@getrefill.app";
const REFILL_FROM_ENABLED = process.env.REFILL_FROM_ENABLED === "1";
const FROM_MAILBOX = REFILL_FROM_ENABLED ? REFILL_FROM_MAILBOX : LEGACY_FROM_MAILBOX;
const NOTIFY_RECIPIENTS = (
  process.env.REFILL_SETUP_NOTIFY_TO ?? "david@openagentic.site"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function admin() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const submitInput = z.object({
  email: z.string().email().max(320),
  practiceName: z.string().min(1).max(200),
  scheduler: z.string().min(1).max(120),
  phone: z.string().max(60).nullable().optional(),
  estimatedMonthlyCancels: z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .nullable()
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
  source: z.string().max(300).nullable().optional(),
});

export const submitRefillSetupIntent = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => submitInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; id: string }> => {
    const sb = admin();
    const email = data.email.trim().toLowerCase();
    const now = new Date().toISOString();

    // Re-use the leads pipeline. If a prior scan exists for this email,
    // attach the intent to the most-recent row; otherwise insert a fresh
    // intent-only row. Either way the spa gets ONE row in our leads view.
    const { data: existing } = await sb
      .from("csv_scanner_leads")
      .select("id, setup_intent_at")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let leadId: string;
    if (existing && !existing.setup_intent_at) {
      const { error: updateErr } = await sb
        .from("csv_scanner_leads")
        .update({
          setup_intent_at: now,
          setup_intent_practice_name: data.practiceName,
          setup_intent_scheduler: data.scheduler,
          setup_intent_phone: data.phone ?? null,
          setup_intent_estimated_monthly_cancels:
            data.estimatedMonthlyCancels ?? null,
          setup_intent_notes: data.notes ?? null,
        })
        .eq("id", existing.id);
      if (updateErr) {
        throw new Error(`Couldn't save your intake: ${updateErr.message}`);
      }
      leadId = existing.id;
    } else {
      const { data: row, error: insertErr } = await sb
        .from("csv_scanner_leads")
        .insert({
          email,
          source: data.source ?? null,
          setup_intent_at: now,
          setup_intent_practice_name: data.practiceName,
          setup_intent_scheduler: data.scheduler,
          setup_intent_phone: data.phone ?? null,
          setup_intent_estimated_monthly_cancels:
            data.estimatedMonthlyCancels ?? null,
          setup_intent_notes: data.notes ?? null,
        })
        .select("id")
        .single();
      if (insertErr) {
        throw new Error(`Couldn't save your intake: ${insertErr.message}`);
      }
      leadId = row.id;
    }

    // v372.1: AWAIT the notification — the comment above said "awaited"
    // but the code below was void+catch fire-and-forget, the EXACT
    // anti-pattern feedback_workers_no_fire_and_forget warns about.
    // Cloudflare Workers terminate the isolate on response return,
    // killing any unresolved promise. User sees "Got it" but Karen +
    // David never get notified. Awaiting costs ~2s of extra UI
    // spinner; reliability wins.
    try {
      await sendIntakeNotification(sb, leadId, data);
    } catch (err) {
      // sendIntakeNotification already stamps setup_intent_notified_error
      // on any handled failure path. Defensive catch here for any
      // unhandled exception that escapes.
      console.warn(
        "[submitRefillSetupIntent] notification send threw unhandled:",
        err instanceof Error ? err.message : err,
      );
    }

    return { ok: true, id: leadId };
  });

async function sendIntakeNotification(
  sb: ReturnType<typeof admin>,
  leadId: string,
  data: z.infer<typeof submitInput>,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    await sb
      .from("csv_scanner_leads")
      .update({
        setup_intent_notified_error: "RESEND_API_KEY not configured",
      })
      .eq("id", leadId);
    return;
  }
  if (NOTIFY_RECIPIENTS.length === 0) {
    await sb
      .from("csv_scanner_leads")
      .update({
        setup_intent_notified_error: "REFILL_SETUP_NOTIFY_TO not configured",
      })
      .eq("id", leadId);
    return;
  }

  const subject = `🔔 New Refill setup intent — ${data.practiceName}`;
  const text = [
    `New Refill setup intent just landed.`,
    ``,
    `Practice: ${data.practiceName}`,
    `Email: ${data.email}`,
    `Phone: ${data.phone ?? "—"}`,
    `Current scheduler: ${data.scheduler}`,
    `Estimated cancels/mo: ${data.estimatedMonthlyCancels ?? "—"}`,
    ``,
    `Notes:`,
    `${data.notes ?? "(none)"}`,
    ``,
    `Lead row: ${leadId}`,
    `Source: ${data.source ?? "(unknown)"}`,
    ``,
    `Onboard within 24 hours. Reply directly to ${data.email} to get rolling.`,
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Refill intake <${FROM_MAILBOX}>`,
        to: NOTIFY_RECIPIENTS,
        reply_to: data.email,
        subject,
        text,
        tags: [
          { name: "type", value: "refill-setup-intent" },
          {
            name: "scheduler",
            value: data.scheduler
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .slice(0, 40),
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
    }
    await sb
      .from("csv_scanner_leads")
      .update({
        setup_intent_notified_at: new Date().toISOString(),
        setup_intent_notified_error: null,
      })
      .eq("id", leadId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sb
      .from("csv_scanner_leads")
      .update({ setup_intent_notified_error: message.slice(0, 500) })
      .eq("id", leadId);
  }
}
