/**
 * Shared lane-router for token-authenticated manufacturer CSV ingestion.
 *
 * One CSV + one reward-ingest token → the right ingest core, auto-detected:
 *   - a manufacturer transaction / last-treatment report  → transaction lane
 *   - anything else (a reward-balance snapshot)            → reward lane
 *
 * This is the exact routing the inbound email-drop receiver
 * (/api/resend/inbound-rewards) and the direct Portal-MCP endpoint
 * (/api/ingest/rewards) both need — extracted so the two delivery
 * mechanisms (email forward vs. local browser-automation POST) share one
 * code path into the same detect()→ingest→Recall pipe. No new ingest logic;
 * just dispatch.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  ingestRewardCsvByToken,
  resolveRewardIngestToken,
  type RewardImportReceipt,
} from "@/server/manufacturer-reward-ingest.functions";
import {
  isLastTransactionCsv,
  ingestLastTxnCsvForUser,
  type LastTxnImportReceipt,
} from "@/server/manufacturer-transaction-ingest.functions";

type Sb = SupabaseClient<Database>;

export type RoutedIngestResult =
  | {
      lane: "transaction";
      ok: boolean;
      detected: string | null;
      reason: string | null;
      receipt: LastTxnImportReceipt | null;
    }
  | {
      lane: "reward";
      ok: boolean;
      detected: string | null;
      reason: string | null;
      receipt: RewardImportReceipt | null;
    };

/**
 * Route one CSV to the correct ingest lane and run it. The token is the only
 * credential; the transaction lane is keyed by the resolved user_id, the
 * reward lane re-resolves internally (one extra cheap read).
 */
export async function ingestCsvByTokenRouted(
  sb: Sb,
  token: string,
  csv: string,
  sourceFilename: string | null,
): Promise<RoutedIngestResult> {
  if (isLastTransactionCsv(csv)) {
    const userId = await resolveRewardIngestToken(sb, token);
    if (!userId) {
      return {
        lane: "transaction",
        ok: false,
        detected: null,
        reason: "unknown_token",
        receipt: null,
      };
    }
    const r = await ingestLastTxnCsvForUser(sb, userId, csv, sourceFilename);
    return {
      lane: "transaction",
      ok: r.ok,
      detected: r.detected,
      reason: r.reason,
      receipt: r.receipt,
    };
  }

  const r = await ingestRewardCsvByToken(sb, token, csv, sourceFilename);
  return {
    lane: "reward",
    ok: r.ok,
    detected: r.detected,
    reason: r.reason,
    receipt: r.receipt,
  };
}
