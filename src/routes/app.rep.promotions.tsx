/**
 * /app/rep/promotions — layout shell (v338.2).
 *
 * Pure layout file. Renders only an <Outlet/> so child routes mount in place:
 *   - app.lizzie.promotions.index.tsx        → list at /app/rep/promotions
 *   - app.lizzie.promotions.$promotionId.tsx → detail at /app/rep/promotions/$id
 *
 * Why this exists: TanStack's file-routing treats dot-separated names as
 * nested by default. Pre-v338.2, app.lizzie.promotions.tsx WAS the list page
 * (full PromotionsListPage component, no Outlet). $promotionId was therefore
 * mounted invisibly underneath the list — the detail page (with Hero card,
 * Tier ladder, and Blast composer) was completely unreachable from the
 * deployed app. Same bug pattern v331 fixed at the /app/rep level.
 *
 * The list page now lives at app.lizzie.promotions.index.tsx.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/rep/promotions")({
  component: PromotionsLayout,
});

function PromotionsLayout() {
  return <Outlet />;
}
