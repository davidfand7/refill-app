# SmartSpa

The patient-profitability OS for med-spas. (Refill is the no-show-recovery Solution within it.) Standalone product, separated from the openagenticv4 monorepo on 2026-05-24.

## Stack

- Vite + React 19 + TanStack Start (file-based routing, SSR)
- Tailwind CSS 4
- Cloudflare Workers (single worker serves all Refill domains)
- Supabase (Auth + Postgres + RLS) — dedicated `refill-prod` project
- Stripe (billing), Resend (transactional email), Twilio + Bandwidth (SMS), Acuity (scheduler integration)

## Project status

This repo was created on 2026-05-24 as Phase 1 of a planned 2-week cleave from openagenticv4. The plan and rationale live in `/Users/david_air/Desktop/David Claude Projects/Refill-Cleave-Plan.html`.

Phase 1 (current) — Scaffolding & infrastructure
Phase 2 — Schema port (45 migrations)
Phase 3 — Code port (~30 server fns, ~70 routes, simplify the bridge stack out of existence)
Phase 4 — Data migration & cut-over

## Development

```sh
bun install
bun run dev    # localhost:8080
bun run build  # production build
bun run deploy # wrangler deploy
```

## Architecture principles

1. **Single apex.** Site URL = `getrefill.app`. No cross-host bridges. No Site-URL strip workarounds.
2. **Single shell.** No multi-tenant shell switching. No host-aware injection. Refill is Refill.
3. **Single product context.** No `product`/`surface` stamping. The worker serves Refill or it doesn't run.
4. **The trojan horse lives in our heads.** Refill is a narrow, focused product. Strategic ambition stays out of the artifact.
