/**
 * /r/<slug> — short referral link resolver (v406, Pinch #10).
 *
 * Reps share `getrefill.app/r/kelly-caffee` instead of the 200+ char
 * `/onboard?ref=eyJyZXAi…` JWT URL we shipped in v395. The slug is
 * persisted in `rep_referral_links` by mintMyReferralLink; this route
 * looks up the slug server-side (via resolveReferralSlug), audits the
 * resolution (bumps use_count + last_used_at), and 30x-redirects to the
 * underlying `/onboard?ref=<token>` URL with the HMAC-signed token.
 *
 * Execution is in `beforeLoad` so the redirect happens BEFORE any React
 * tree mounts — no flash of an empty resolver page. Unknown slugs throw
 * a redirect to `/` with a `?ref_404=<slug>` search param the marketing
 * landing can optionally surface.
 *
 * Cross-host behavior: the route is reachable from both getrefill.app
 * and agentiport.com (TanStack file routing serves the same routes on
 * all hosts). resolveReferralSlug returns a FULL URL targeting the
 * REFILL_PUBLIC_ORIGIN, so cross-host hits redirect to the canonical
 * getrefill.app onboard surface regardless of where the click landed.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { resolveReferralSlug } from "@/server/rep-platform";

// v408: optional ?e=<engagement-event-id> threads through from rep-recruit
// emails. We pass it into resolveReferralSlug which appends it onto the
// redirect target URL (&e=<id>). The /onboard route reads it from search
// and writes a cookie so it survives the magic-link round-trip.
const rSearchSchema = z.object({
  e: z.string().uuid().optional(),
});

export const Route = createFileRoute("/r/$slug")({
  validateSearch: (raw: Record<string, unknown>) => rSearchSchema.parse(raw),
  beforeLoad: async ({ params, search }) => {
    const slug = params.slug.toLowerCase();
    const { targetUrl } = await resolveReferralSlug({
      data: { slug, eventId: search.e },
    });
    if (!targetUrl) {
      // Unknown slug — bounce to the marketing apex. The landing renders
      // its normal content; a friendlier "that link doesn't exist" surface
      // can land later if cold-link friction shows up in real data.
      throw redirect({ to: "/", replace: true });
    }
    // Full-URL redirect — targetUrl includes the canonical host
    // (REFILL_PUBLIC_ORIGIN, defaults to https://getrefill.app) so a
    // cross-host /r hit on agentiport.com still lands on the right
    // /onboard surface.
    throw redirect({ href: targetUrl, replace: true });
  },
});
