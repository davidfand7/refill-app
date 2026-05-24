/**
 * /app/rep — Refill rep dashboard home.
 *
 * Cleave rewrite 2026-05-24: replaces openagenticv4's 1,148 LOC Liz-chat
 * surface. That file was the Lizzie(OS) AI chat for medical-aesthetics
 * reps (Galderma/Allergan products) — a separate Agentiport product that
 * doesn't exist in Refill. Refill's rep platform is rep-recruits-spa
 * territory: referral links, sub-rep network, commission ledger.
 *
 * Renders RefillRepHome (sibling of RefillHome for spa owners — same
 * paper/emerald/Georgia aesthetic).
 *
 * The original 1,148 LOC file lives in openagenticv4 if Lizzie chat ever
 * gets revived as a separate product surface.
 */

import { createFileRoute } from "@tanstack/react-router";

import { RefillRepHome } from "@/components/refill/RefillRepHome";

export const Route = createFileRoute("/app/rep/")({
  component: RefillRepHome,
});
