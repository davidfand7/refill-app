/**
 * /app/refill/recognition/brand-promos — RETIRED v2.94 (manufacturer-promo
 * consolidation, step 3).
 *
 * The eligible-promos + rep-interest loop that used to live here is now a card
 * on the unified Rewards offers surface (RepPromosCard, gated by the
 * `rep_loop_enabled` flag — it ships dark until a rep pipeline feeds it). The
 * tile-list UI moved into src/components/refill/RepPromosCard.tsx; the spa-side
 * server fns (listEligiblePromosForSpa / expressInterestInPromo /
 * dismissPromoForSpa) stay in src/server/refill-promos.ts and back the card.
 *
 * This route now just redirects any old bookmark / email link to Rewards so
 * nothing dead-ends. The Brand Promos tab was removed from RecognitionTabs.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/recognition/brand-promos")({
  beforeLoad: () => {
    throw redirect({ to: "/app/refill/recognition/rewards", replace: true });
  },
});
