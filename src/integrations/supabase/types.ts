/**
 * Placeholder Database type. Populated by `supabase gen types typescript`
 * after Phase 2 (schema port) lands the 45 migrations against the new
 * refill-prod project.
 *
 * Until then, server fns + queries fall back to `any` shape — acceptable
 * because there's no real query code in the repo yet (Phase 3 brings it).
 *
 * Regenerate command (run after every migration in Phase 2):
 *   bunx supabase gen types typescript \
 *     --project-id pxgzbibcmbxxqycuplga \
 *     > src/integrations/supabase/types.ts
 */
export type Database = {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
