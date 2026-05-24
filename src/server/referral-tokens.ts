/**
 * Referral token mint + validate (Phase 2C).
 *
 * Stateless HMAC-SHA256-signed tokens encoding a rep_user_id. No DB roundtrip
 * on validation — the signature IS the proof. Lifetime by design (no expiry);
 * revocation = rotate REFERRAL_TOKEN_SECRET.
 *
 * Format:  base64url(payload).base64url(sig)
 *   payload = JSON.stringify({ rep: <uuid>, v: 1 })
 *   sig     = HMAC-SHA256(payload_b64, REFERRAL_TOKEN_SECRET)
 *
 * Validation does constant-time signature comparison via crypto.timingSafeEqual
 * to avoid timing-side-channel leaks against the secret.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 1;

function getSecret(): string {
  const secret = process.env.REFERRAL_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "Server is missing REFERRAL_TOKEN_SECRET (or it's < 32 chars).",
    );
  }
  return secret;
}

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64");
}

function sign(payloadB64: string, secret: string): string {
  return b64urlEncode(
    createHmac("sha256", secret).update(payloadB64).digest(),
  );
}

export function mintReferralToken(repId: string): string {
  if (!repId || repId.length < 8) {
    throw new Error("mintReferralToken: invalid repId");
  }
  const payload = JSON.stringify({ rep: repId, v: TOKEN_VERSION });
  const payloadB64 = b64urlEncode(payload);
  const sig = sign(payloadB64, getSecret());
  return `${payloadB64}.${sig}`;
}

export type ReferralPayload = { repId: string };

export function validateReferralToken(token: string): ReferralPayload | null {
  if (typeof token !== "string" || token.length < 16) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  let expected: string;
  try {
    expected = sign(payloadB64, getSecret());
  } catch {
    return null;
  }

  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  try {
    const json = b64urlDecode(payloadB64).toString("utf8");
    const obj = JSON.parse(json) as { rep?: unknown; v?: unknown };
    if (typeof obj.rep !== "string" || obj.rep.length < 8) return null;
    if (obj.v !== TOKEN_VERSION) return null;
    return { repId: obj.rep };
  } catch {
    return null;
  }
}
