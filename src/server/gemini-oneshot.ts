/**
 * Shared single-shot Gemini caller for Vertex AI.
 *
 * Extracted from promotions.functions.ts so Emma + Lizzie + future surfaces
 * can share the call shape (auth, model, timeout, finish-reason handling)
 * without coupling to each other's draft prompts. The prompt + parsing
 * logic stays in each caller — only the HTTP wiring is shared.
 *
 * See [[project-gemini-thinking-token-trap]] — 2.5-pro burns thinking
 * tokens before visible output, so maxOutputTokens must leave headroom.
 *
 * Established 2026-05-15 (Emma Promotions Engine Phase 3.0).
 */

import { loadServiceAccount, getVertexAccessToken } from "@/server/google-auth";

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
};

export type GeminiOneShotOptions = {
  /** Defaults to 0.4 — warmer than 0 (variety in drafts), cooler than 0.7 (consistent voice). */
  temperature?: number;
  /** Defaults to 4096 — leaves headroom for 2.5-pro's thinking-token overhead. */
  maxOutputTokens?: number;
  /** Defaults to 30s. Per-request abort guard. */
  timeoutMs?: number;
};

/**
 * Single-shot Gemini call: no tools, no chat turns, just systemInstruction
 * + one user message → text out. Throws with a finishReason-aware message
 * on empty responses so the caller can surface "model truncated".
 */
export async function callGeminiOneShot(
  systemPrompt: string,
  userPrompt: string,
  opts: GeminiOneShotOptions = {},
): Promise<string> {
  const sa = loadServiceAccount();
  const accessToken = await getVertexAccessToken(sa);
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";
  const location = process.env.GEMINI_LOCATION ?? "us-central1";
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 30_000,
  );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Gemini one-shot failed (${res.status}): ${errText.slice(0, 400)}`,
      );
    }
    const j = (await res.json()) as GeminiResponse;
    const text =
      j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) {
      throw new Error(
        "Gemini returned no text — finishReason=" +
          (j.candidates?.[0]?.finishReason ?? "unknown"),
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
