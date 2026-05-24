/**
 * Refill Rep Platform — Zoho via Composio (Phase 2F, v398).
 *
 * Three rep-facing surfaces:
 *
 *   getZohoToolkitSlug
 *     Discovers the Composio toolkit slug for Zoho CRM by querying
 *     composio_supported_toolkits (populated nightly by the broker cron).
 *     Returns null if the cron hasn't run yet or Zoho isn't supported.
 *     The slug shape varies by provider — Composio uses e.g. "GMAIL",
 *     "SLACK", but Zoho could be "ZOHO", "ZOHOCRM", "ZOHO_CRM", etc.
 *     Discovering at runtime is robust to whatever Composio settles on.
 *
 *   getMyZohoConnection
 *     Reads workspace_connections for the current user, scoped to the
 *     Zoho toolkit slug. Returns { connected, accountLabel, connectedAt }
 *     or null. account_label = Composio's connectedAccountId, opaque to us.
 *
 *   syncMyZohoContacts
 *     Pulls a recent batch of contacts from the connected Zoho account via
 *     Composio's tool-execute API. Returns up to 25 contacts with name +
 *     email. Phase 2F-grade: one-shot pull, no local cache. Phase 2G adds
 *     a zoho_contacts table + persistence + "Add to outreach audience" CTA.
 *
 * No new tables — reuses workspace_connections + composio_supported_toolkits
 * from the existing Composio broker infra.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { Composio } from "@composio/core";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { requireRepOrAdmin } from "@/server/auth-helpers";

type SbClient = ReturnType<typeof createClient<Database>>;

function admin(): SbClient {
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

const authInput = z.object({
  accessToken: z.string().min(1),
});

// ─── getZohoToolkitSlug ──────────────────────────────────────────────────

export const getZohoToolkitSlug = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => authInput.parse(raw))
  .handler(async ({ data }): Promise<{ slug: string | null }> => {
    const sb = admin();
    await requireRepOrAdmin(sb, data.accessToken);

    // Look for any toolkit whose slug looks like Zoho. We prefer ZOHO_CRM
    // over the bare ZOHO because Zoho has multiple products (CRM, Books,
    // Desk, Inventory, etc.) and the CRM connector is the one Kelly cares
    // about for the contact-sync demo.
    const { data: rows, error } = await sb
      .from("composio_supported_toolkits")
      .select("slug")
      .ilike("slug", "%zoho%")
      .order("slug", { ascending: true });
    if (error) {
      throw new Error(`Couldn't query supported toolkits: ${error.message}`);
    }

    const slugs = (rows ?? []).map((r) => r.slug);
    if (slugs.length === 0) {
      // Cron may not have populated yet — fall back to the most likely
      // Composio slug. /api/composio/connect will return not_supported if
      // we're wrong; the UI handles that gracefully.
      return { slug: "ZOHO_CRM" };
    }
    // Prefer CRM-specific over bare Zoho.
    const crm = slugs.find((s) => /crm/i.test(s));
    return { slug: crm ?? slugs[0] };
  });

// ─── getMyZohoConnection ─────────────────────────────────────────────────

export type ZohoConnection = {
  connected: boolean;
  integrationId: string;
  accountLabel: string | null;
  status: string;
  connectedAt: string | null;
};

const connInput = authInput.extend({
  toolkitSlug: z.string().min(1).max(64),
});

export const getMyZohoConnection = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => connInput.parse(raw))
  .handler(async ({ data }): Promise<{ connection: ZohoConnection | null }> => {
    const sb = admin();
    const principal = await requireRepOrAdmin(sb, data.accessToken);

    const { data: row, error } = await sb
      .from("workspace_connections")
      .select("integration_id, account_label, status, connected_at")
      .eq("user_id", principal.userId)
      .eq("integration_id", data.toolkitSlug)
      .maybeSingle();
    if (error) {
      throw new Error(`Couldn't load connection: ${error.message}`);
    }
    if (!row) return { connection: null };

    return {
      connection: {
        connected: row.status === "connected",
        integrationId: row.integration_id,
        accountLabel: row.account_label,
        status: row.status,
        connectedAt: row.connected_at,
      },
    };
  });

// ─── syncMyZohoContacts ──────────────────────────────────────────────────

export type ZohoContact = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  accountName: string | null;
  title: string | null;
  phone: string | null;
};

const syncInput = authInput.extend({
  toolkitSlug: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(50).optional(),
});

export const syncMyZohoContacts = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => syncInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      contacts: ZohoContact[];
      actionSlug: string;
      message: string;
    }> => {
      const sb = admin();
      const principal = await requireRepOrAdmin(sb, data.accessToken);

      const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;
      if (!COMPOSIO_API_KEY) {
        throw new Error("COMPOSIO_API_KEY is not configured on the worker.");
      }

      // Confirm a connected account exists for this user + toolkit before
      // attempting the tool execute (Composio would error otherwise).
      const { data: connRow } = await sb
        .from("workspace_connections")
        .select("status")
        .eq("user_id", principal.userId)
        .eq("integration_id", data.toolkitSlug)
        .maybeSingle();
      if (!connRow || connRow.status !== "connected") {
        throw new Error(
          "Not connected to Zoho. Connect first, then try sync again.",
        );
      }

      const composio = new Composio({ apiKey: COMPOSIO_API_KEY });

      // Pick the right "get contacts" action for the toolkit dynamically.
      // Composio's action catalog uses slugs like ZOHO_CRM_GET_CONTACTS,
      // ZOHO_CRM_LIST_CONTACTS, ZOHO_GET_CONTACTS — the exact name varies
      // by provider release. We probe the list and pick the first match.
      let actionSlug: string;
      try {
        const actions = await (composio as any).actions.list({
          toolkit: data.toolkitSlug,
        });
        const items: { slug: string; name?: string }[] =
          actions?.items ?? actions ?? [];
        const contactsAction = items.find((a) =>
          /(get|list|fetch)_?contacts?/i.test(a.slug ?? ""),
        );
        actionSlug =
          contactsAction?.slug ?? `${data.toolkitSlug}_GET_CONTACTS`;
      } catch {
        // Couldn't introspect — fall back to convention.
        actionSlug = `${data.toolkitSlug}_GET_CONTACTS`;
      }

      // Execute the action against the user's connected account.
      let raw: unknown;
      try {
        const limit = data.limit ?? 25;
        // Composio SDK v0.8.x uses tools.execute(actionSlug, { userId, arguments }).
        // We pass `userId` because that's how Composio maps to the connected
        // account (it was registered with userId in initiate()).
        raw = await (composio as any).tools.execute(actionSlug, {
          userId: principal.userId,
          arguments: { per_page: limit, page: 1 },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `Zoho contact-sync failed via Composio (action ${actionSlug}): ${msg}`,
        );
      }

      const contacts = normalizeZohoContacts(raw);
      return {
        contacts,
        actionSlug,
        message:
          contacts.length === 0
            ? "Connected, but no contacts returned. (Zoho account may be empty.)"
            : `Pulled ${contacts.length} contact${contacts.length === 1 ? "" : "s"} from Zoho.`,
      };
    },
  );

// ─── Response normalization ──────────────────────────────────────────────
//
// Composio wraps every tool-execute response in a successful/data envelope.
// Zoho CRM's GET /Contacts returns { data: Contact[] } at the inner level.
// We normalize across both layers + handle a few shape variations so the UI
// always gets a flat ZohoContact[].

function normalizeZohoContacts(raw: unknown): ZohoContact[] {
  if (!raw || typeof raw !== "object") return [];
  const wrapped = raw as Record<string, unknown>;

  // Walk the typical envelopes Composio uses.
  const candidates: unknown[] = [
    wrapped.data,
    (wrapped.response_data as Record<string, unknown> | undefined)?.data,
    (wrapped.successful as Record<string, unknown> | undefined)?.data,
    (wrapped.result as Record<string, unknown> | undefined)?.data,
    wrapped.contacts,
    wrapped,
  ];

  let list: unknown[] | null = null;
  for (const c of candidates) {
    if (Array.isArray(c)) {
      list = c;
      break;
    }
    if (c && typeof c === "object" && Array.isArray((c as { data?: unknown }).data)) {
      list = (c as { data: unknown[] }).data;
      break;
    }
  }
  if (!list) return [];

  return list.slice(0, 50).map((entry) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    const firstName = str(c.First_Name ?? c.first_name);
    const lastName = str(c.Last_Name ?? c.last_name);
    const explicitFull = str(c.Full_Name ?? c.full_name);
    const composedFull = [firstName, lastName].filter(Boolean).join(" ").trim();
    const fullName = explicitFull ?? (composedFull || null);
    return {
      id: String(c.id ?? c.Id ?? c.contact_id ?? ""),
      firstName,
      lastName,
      fullName: fullName || null,
      email: str(c.Email ?? c.email),
      accountName: str(c.Account_Name ?? c.account_name),
      title: str(c.Title ?? c.title),
      phone: str(c.Phone ?? c.phone ?? c.Mobile ?? c.mobile),
    };
  });
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && "name" in (v as Record<string, unknown>)) {
    return str((v as Record<string, unknown>).name);
  }
  return null;
}
