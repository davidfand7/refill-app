/**
 * Stripe webhook receiver — POST /api/webhooks/stripe (v1.8, Phase B-full).
 *
 * Closes the production-reliability gap left by Phase B-lite (v1.7.2).
 * The synchronous `stripe.invoices.pay()` call covers card-on-file flow,
 * but webhooks are the authoritative source of truth for any async path:
 *
 *   - invoice.paid                  → flip refill_invoices.status to 'paid'
 *   - invoice.payment_failed        → flip status to 'failed'
 *   - invoice.finalization_failed   → flip status to 'failed'
 *
 * Idempotency lives in stripe_webhook_events (unique on stripe_event_id) —
 * Stripe retries on any non-2xx and re-fires on delivery uncertainty, so
 * the handler must safely no-op on duplicates. We insert the audit row
 * first; if the insert hits the unique violation (23505), we return 200
 * immediately and skip all branches.
 *
 * Always returns 200 (even on most errors) so Stripe doesn't pound the
 * endpoint in exponential-retry mode — failures are captured in the audit
 * row's error_message column for forensic replay.
 *
 * Required env:
 *   STRIPE_SECRET_KEY        (already set, used for client init)
 *   STRIPE_WEBHOOK_SECRET    (NEW — set via `wrangler secret put STRIPE_WEBHOOK_SECRET`
 *                             after creating the endpoint in Stripe Dashboard)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Why constructEventAsync (not constructEvent): Cloudflare Workers don't
 * expose Node's crypto.createHmac sync API. The async variant uses Web
 * Crypto under the hood — same HMAC-SHA256, runtime-portable.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

import type { Database } from "@/integrations/supabase/types";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/webhooks/stripe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
        const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (
          !STRIPE_SECRET_KEY ||
          !STRIPE_WEBHOOK_SECRET ||
          !SUPABASE_URL ||
          !SERVICE_KEY
        ) {
          console.error(
            "[stripe-webhook] missing env: " +
              JSON.stringify({
                STRIPE_SECRET_KEY: Boolean(STRIPE_SECRET_KEY),
                STRIPE_WEBHOOK_SECRET: Boolean(STRIPE_WEBHOOK_SECRET),
                SUPABASE_URL: Boolean(SUPABASE_URL),
                SUPABASE_SERVICE_ROLE_KEY: Boolean(SERVICE_KEY),
              }),
          );
          // 500 here is intentional — if env is broken, we want Stripe to
          // retry once the env is fixed, not silently drop the event.
          return jsonResp(500, { error: "Server not configured" });
        }

        // Raw body is required for signature verification — read it BEFORE
        // any parsing. The Stripe signature is HMAC-SHA256 over the exact
        // byte sequence Stripe sent; any re-serialization changes the hash.
        const rawBody = await request.text();
        const signature = request.headers.get("stripe-signature");

        if (!signature) {
          console.warn("[stripe-webhook] missing stripe-signature header");
          return jsonResp(400, { error: "Missing signature" });
        }

        const stripe = new Stripe(STRIPE_SECRET_KEY, {
          apiVersion: "2026-04-22.dahlia",
        });

        // Verify the event came from Stripe (HMAC-SHA256 over raw body
        // against the signing secret + tolerance window). constructEventAsync
        // is the Workers/browser-safe variant — uses Web Crypto, not Node's
        // crypto.createHmac (which isn't available on CF Workers).
        let event: Stripe.Event;
        try {
          event = await stripe.webhooks.constructEventAsync(
            rawBody,
            signature,
            STRIPE_WEBHOOK_SECRET,
          );
        } catch (e) {
          console.warn(
            "[stripe-webhook] signature verification failed:",
            e instanceof Error ? e.message : String(e),
          );
          return jsonResp(400, { error: "Invalid signature" });
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // Identify the product this event belongs to. We control the
        // `metadata.product` contract on invoices created by the refill
        // cron (see generateMonthlyInvoiceForTenant in src/server/refill-billing.ts).
        // Events without product:refill (legacy emma platform subs, WCS
        // payouts, etc.) get audited but skip the refill_invoices update.
        const product = extractProduct(event);

        // ── Idempotency: insert audit row first. Unique constraint on
        //    stripe_event_id means a duplicate retry from Stripe hits
        //    Postgres 23505 and we acknowledge with 200 + skip branches.
        const auditInsert = await sb
          .from("stripe_webhook_events")
          .insert({
            stripe_event_id: event.id,
            event_type: event.type,
            product,
            payload: event as unknown as Database["public"]["Tables"]["stripe_webhook_events"]["Insert"]["payload"],
            status: "received",
          })
          .select("id")
          .single();

        if (auditInsert.error) {
          if (auditInsert.error.code === "23505") {
            // Duplicate retry — already processed (or processing).
            return jsonResp(200, { duplicate: true, event_id: event.id });
          }
          console.error(
            "[stripe-webhook] audit insert failed:",
            auditInsert.error.message,
          );
          // Still ack so Stripe doesn't hammer us; investigate via logs.
          return jsonResp(200, { error: "audit_insert_failed" });
        }
        const auditId = auditInsert.data.id;

        // ── Route the event. Only the three invoice transitions actually
        //    write to refill_invoices; everything else gets audited as
        //    'processed' (so the count of suppressed-by-no-handler is
        //    visible later) but takes no DB action.
        try {
          let outcome: { handled: boolean; detail: string };

          if (product !== "refill") {
            outcome = {
              handled: false,
              detail: `skipped (product=${product ?? "unknown"})`,
            };
          } else if (event.type === "invoice.paid") {
            outcome = await handleInvoicePaid(sb, event);
          } else if (event.type === "invoice.payment_failed") {
            outcome = await handleInvoiceFailed(sb, event, "payment_failed");
          } else if (event.type === "invoice.finalization_failed") {
            outcome = await handleInvoiceFailed(
              sb,
              event,
              "finalization_failed",
            );
          } else {
            outcome = {
              handled: false,
              detail: `no handler for ${event.type}`,
            };
          }

          await sb
            .from("stripe_webhook_events")
            .update({
              status: "processed",
              processed_at: new Date().toISOString(),
            })
            .eq("id", auditId);

          return jsonResp(200, {
            ok: true,
            event_id: event.id,
            event_type: event.type,
            product,
            ...outcome,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error("[stripe-webhook] handler threw:", message);
          await sb
            .from("stripe_webhook_events")
            .update({
              status: "failed",
              processed_at: new Date().toISOString(),
              error_message: message,
            })
            .eq("id", auditId);
          // Still ack — Stripe retries don't help here, the handler error
          // is on our side. Forensic info lives in the audit row.
          return jsonResp(200, { ok: false, event_id: event.id, error: message });
        }
      },
    },
  },
});

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleInvoicePaid(
  sb: ReturnType<typeof createClient<Database>>,
  event: Stripe.Event,
): Promise<{ handled: boolean; detail: string }> {
  const invoice = event.data.object as Stripe.Invoice;
  if (!invoice.id) {
    return { handled: false, detail: "no invoice.id on event" };
  }

  const { data: row, error: selErr } = await sb
    .from("refill_invoices")
    .select("id, status")
    .eq("stripe_invoice_id", invoice.id)
    .maybeSingle();

  if (selErr) {
    throw new Error(`refill_invoices lookup failed: ${selErr.message}`);
  }
  if (!row) {
    return {
      handled: false,
      detail: `no refill_invoices row for stripe_invoice_id=${invoice.id}`,
    };
  }
  if (row.status === "paid") {
    return { handled: true, detail: "already paid (no-op)" };
  }

  const now = new Date().toISOString();
  const { error: updErr } = await sb
    .from("refill_invoices")
    .update({
      status: "paid",
      paid_at: now,
      // sent_at may have been stamped earlier by the synchronous push; if
      // not (e.g. invoice created out-of-band in Stripe Dashboard), stamp
      // it now so the row's lifecycle is consistent.
      sent_at: now,
    })
    .eq("id", row.id)
    .is("paid_at", null);
  // The `.is("paid_at", null)` guard makes the update a no-op on retries
  // that arrive after a prior webhook already stamped the row — belt + braces
  // alongside the audit-row idempotency.

  if (updErr) {
    throw new Error(`refill_invoices update failed: ${updErr.message}`);
  }
  return { handled: true, detail: `flipped to paid (row=${row.id})` };
}

async function handleInvoiceFailed(
  sb: ReturnType<typeof createClient<Database>>,
  event: Stripe.Event,
  kind: "payment_failed" | "finalization_failed",
): Promise<{ handled: boolean; detail: string }> {
  const invoice = event.data.object as Stripe.Invoice;
  if (!invoice.id) {
    return { handled: false, detail: "no invoice.id on event" };
  }

  const { data: row, error: selErr } = await sb
    .from("refill_invoices")
    .select("id, status")
    .eq("stripe_invoice_id", invoice.id)
    .maybeSingle();

  if (selErr) {
    throw new Error(`refill_invoices lookup failed: ${selErr.message}`);
  }
  if (!row) {
    return {
      handled: false,
      detail: `no refill_invoices row for stripe_invoice_id=${invoice.id}`,
    };
  }
  if (row.status === "paid") {
    // Edge: payment_failed arrives after a later retry already paid.
    // Don't flip a paid row back to failed.
    return { handled: true, detail: "already paid — ignoring failure" };
  }

  const { error: updErr } = await sb
    .from("refill_invoices")
    .update({ status: "failed" })
    .eq("id", row.id);

  if (updErr) {
    throw new Error(`refill_invoices update failed: ${updErr.message}`);
  }
  return { handled: true, detail: `flipped to failed (${kind}, row=${row.id})` };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractProduct(event: Stripe.Event): string | null {
  const obj = event.data.object as { metadata?: Record<string, string> | null };
  const product = obj?.metadata?.product;
  return typeof product === "string" && product.length > 0 ? product : null;
}
