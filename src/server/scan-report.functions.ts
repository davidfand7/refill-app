/**
 * Public scan-report fetcher (v371.1).
 *
 * Serves the HTML report attached to a follow-up email at /report/<token>.
 * No auth — the token IS the capability, same model as /rescue/claim and
 * /waitlist/optin. The report's HTML was rendered + persisted to
 * csv_scanner_leads.followup_report_html at email-send time.
 *
 * Returns the raw HTML string. The route handler at src/routes/report.$token.tsx
 * sets it as innerHTML on a full-page container so it renders identically to
 * if the user had opened the file directly in their browser — which was the
 * whole point of moving from .html attachment to hosted URL (Gmail and other
 * webmail clients show .html attachments as raw source code; hosted URL
 * renders cleanly everywhere).
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";

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

const getReportInput = z.object({
  token: z.string().min(8).max(200),
});

export const getScanReportHtml = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => getReportInput.parse(input))
  .handler(async ({ data }): Promise<{ html: string | null }> => {
    const sb = admin();
    const { data: row, error } = await sb
      .from("csv_scanner_leads")
      .select("followup_report_html")
      .eq("followup_report_token", data.token)
      .maybeSingle();
    if (error) {
      console.warn("[scan-report] fetch failed:", error.message);
      return { html: null };
    }
    if (!row || !row.followup_report_html) {
      return { html: null };
    }
    return { html: row.followup_report_html };
  });
