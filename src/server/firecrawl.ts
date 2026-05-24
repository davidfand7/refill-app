/**
 * FireCrawl client — server-side wrapper for the FireCrawl scrape/crawl API.
 *
 * This is the PLATFORM-LEVEL FireCrawl capability — distinct from the
 * per-user Firecrawl integration in `src/lib/integrations.ts` (which is
 * a marketplace card users can wire to their own agents). This wrapper
 * is for OUR product flows: the spa-side claim-your-business onboarding
 * (scrape a spa's public website → pre-build their Memory Graph from
 * about/services/hours pages so the owner sees a useful sandbox before
 * activating Hosted Messaging) and rep-side account intel ("what's this
 * spa actually offering?" — pulled live from their public pages).
 *
 * Provenance: anything written into knowledge_nodes from this wrapper
 * should carry compliance.source='scraped-public' (per agent-schema.ts)
 * — the lowest-trust flag in our enum, distinct from FDA-approved-label
 * (which the injectables seed uses).
 *
 * Auth: FIRECRAWL_API_KEY as a Cloudflare Worker secret. Set via
 *   wrangler secret put FIRECRAWL_API_KEY
 *
 * Two functions exposed:
 *   scrapeUrl(url, opts?)  — single-page extraction → markdown + metadata
 *   crawlUrl(url, opts?)   — site-wide crawl from a seed URL (async-style;
 *                            polls until terminal status, bounded)
 *
 * Both return structured results that downstream code can map into
 * knowledge_nodes shapes. Neither is wired to anything yet — call sites
 * land in the spa-side onboarding ship.
 *
 * Reference: https://docs.firecrawl.dev/api-reference (v1)
 *
 * Established 2026-05-09 (v251 scaffold ship — decoupled from injectables seed).
 */

const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const CRAWL_POLL_INTERVAL_MS = 2_000;
const CRAWL_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min ceiling per crawl

function apiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    throw new Error(
      "FIRECRAWL_API_KEY is not configured. " +
        "Set it as a Cloudflare Worker secret: " +
        "`wrangler secret put FIRECRAWL_API_KEY`.",
    );
  }
  return key;
}

async function firecrawlFetch<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${FIRECRAWL_API_BASE}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        ...rest.headers,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `FireCrawl ${path} failed ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Scrape: single-page extraction ─────────────────────────────────────────

export type ScrapeFormat = "markdown" | "html" | "rawHtml" | "links";

/**
 * Pre-extraction action steps. Run in order before FireCrawl snapshots the
 * page. Used for SPA hydration waits and accordion-expand sequences on sites
 * that hide content behind click-to-expand UI (Figma Make / no-code-builder
 * sites are heavy users of this pattern). See FireCrawl docs for the full
 * action vocabulary; we only model the subset we use.
 */
export type ScrapeAction =
  | { type: "wait"; milliseconds?: number; selector?: string }
  | { type: "click"; selector: string; all?: boolean }
  | { type: "executeJavascript"; script: string }
  | { type: "scroll"; direction?: "up" | "down" }
  | { type: "press"; key: string };

export type ScrapeOptions = {
  /** Output formats to request. Default ['markdown']. */
  formats?: ScrapeFormat[];
  /** Strip nav, footer, ads. Default true. */
  onlyMainContent?: boolean;
  /** Request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /**
   * Milliseconds to wait after page load before extracting content. Critical
   * for JS-rendered sites (Wix / Squarespace / Webflow / custom React) where
   * the initial DOM is near-empty until client-side hydration completes.
   * Default 1500ms — added 2026-05-09 (v258) after rejuvskinspa.com showed
   * near-empty extraction despite FireCrawl's default rendering.
   */
  waitFor?: number;
  /**
   * Pre-snapshot actions. Used to expand accordion UI, click-through banners,
   * trigger lazy-load. Sequence runs after waitFor, before content extraction.
   * Added v262 — Rejuv's services page is a Figma Make SPA with deep accordion
   * UI hiding the actual product names + pricing. waitFor alone wasn't enough.
   */
  actions?: ScrapeAction[];
};

export type ScrapeResult = {
  url: string;
  markdown?: string;
  html?: string;
  /**
   * Raw HTML preserving DOM nodes that markdown converters strip — including
   * accordion-collapsed content, aria-hidden tabs, and lazy-loaded panels.
   * Required for spa sites that hide service detail behind expand-on-click
   * UI (caught on rejuvskinspa.com 2026-05-09 — services page accordion
   * had Botox/Volbella/etc. with pricing, FireCrawl markdown returned
   * only the collapsed headers).
   */
  rawHtml?: string;
  links?: string[];
  metadata: {
    title?: string;
    description?: string;
    language?: string;
    sourceURL?: string;
    statusCode?: number;
    [key: string]: unknown;
  };
};

/**
 * Scrape a single URL → clean markdown + metadata. The default workhorse
 * for "give me the about page of this spa" type calls.
 */
export async function scrapeUrl(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const formats = opts.formats ?? ["markdown"];
  const body: Record<string, unknown> = {
    url,
    formats,
    onlyMainContent: opts.onlyMainContent ?? true,
    waitFor: opts.waitFor ?? 1500,
  };
  if (opts.actions && opts.actions.length > 0) {
    body.actions = opts.actions;
  }

  const res = await firecrawlFetch<{
    success: boolean;
    data?: {
      markdown?: string;
      html?: string;
      rawHtml?: string;
      links?: string[];
      metadata?: ScrapeResult["metadata"];
    };
    error?: string;
  }>("/scrape", {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: opts.timeoutMs,
  });

  if (!res.success || !res.data) {
    throw new Error(`FireCrawl scrape failed: ${res.error ?? "unknown error"}`);
  }

  return {
    url,
    markdown: res.data.markdown,
    html: res.data.html,
    rawHtml: res.data.rawHtml,
    links: res.data.links,
    metadata: res.data.metadata ?? {},
  };
}

// ── Crawl: site-wide from a seed URL ───────────────────────────────────────

export type CrawlOptions = {
  /** Max number of pages to fetch. Default 25 (spa-website appropriate). */
  limit?: number;
  /** Glob patterns to include (e.g. ["/services/*", "/about"]). */
  includePaths?: string[];
  /** Glob patterns to exclude (e.g. ["/blog/*"]). */
  excludePaths?: string[];
  /** Output formats per page. Default ['markdown']. */
  formats?: ScrapeFormat[];
  /** Strip nav/footer/ads. Default true. */
  onlyMainContent?: boolean;
  /** Hard ceiling on poll duration in ms. Default 5 min. */
  pollTimeoutMs?: number;
  /** Per-page waitFor in ms; passed through to scrapeOptions. Default 1500. */
  waitFor?: number;
  /**
   * Pre-snapshot actions applied to EVERY page in the crawl. Used to expand
   * accordions / dismiss modals / trigger lazy-load before extraction. Added
   * v262 — see ScrapeAction.
   */
  actions?: ScrapeAction[];
};

export type CrawlResult = {
  jobId: string;
  status: "completed" | "failed" | "timed-out";
  pages: ScrapeResult[];
  total: number;
};

/**
 * Crawl a site from a seed URL. Polls FireCrawl's job-status endpoint
 * until the crawl reaches a terminal state or the poll timeout elapses.
 *
 * For most spa websites a `limit` of 10-25 plus include/exclude patterns
 * is enough to capture about/services/contact/hours without dragging in
 * blogs or galleries.
 */
export async function crawlUrl(
  url: string,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const scrapeOptions: Record<string, unknown> = {
    formats: opts.formats ?? ["markdown"],
    onlyMainContent: opts.onlyMainContent ?? true,
    waitFor: opts.waitFor ?? 1500,
  };
  if (opts.actions && opts.actions.length > 0) {
    scrapeOptions.actions = opts.actions;
  }
  const body = {
    url,
    limit: opts.limit ?? 25,
    includePaths: opts.includePaths,
    excludePaths: opts.excludePaths,
    scrapeOptions,
  };

  // Kick off crawl — returns a job id we then poll for completion.
  const start = await firecrawlFetch<{
    success: boolean;
    id?: string;
    url?: string;
    error?: string;
  }>("/crawl", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!start.success || !start.id) {
    throw new Error(
      `FireCrawl crawl kickoff failed: ${start.error ?? "no job id returned"}`,
    );
  }

  const jobId = start.id;
  const deadline = Date.now() + (opts.pollTimeoutMs ?? CRAWL_POLL_TIMEOUT_MS);

  while (Date.now() < deadline) {
    const status = await firecrawlFetch<{
      status: "scraping" | "completed" | "failed";
      total?: number;
      completed?: number;
      data?: Array<{
        markdown?: string;
        html?: string;
        rawHtml?: string;
        links?: string[];
        metadata?: ScrapeResult["metadata"];
      }>;
    }>(`/crawl/${encodeURIComponent(jobId)}`, { method: "GET" });

    if (status.status === "completed") {
      return {
        jobId,
        status: "completed",
        total: status.total ?? status.data?.length ?? 0,
        pages: (status.data ?? []).map((p) => ({
          url: (p.metadata?.sourceURL as string | undefined) ?? "",
          markdown: p.markdown,
          html: p.html,
          rawHtml: p.rawHtml,
          links: p.links,
          metadata: p.metadata ?? {},
        })),
      };
    }
    if (status.status === "failed") {
      return { jobId, status: "failed", total: 0, pages: [] };
    }

    await new Promise((r) => setTimeout(r, CRAWL_POLL_INTERVAL_MS));
  }

  return { jobId, status: "timed-out", total: 0, pages: [] };
}

// ── Health check (smoke-test convenience) ──────────────────────────────────

/**
 * Confirm the API key is configured and the FireCrawl API is reachable
 * by running a tiny single-URL scrape against example.com. Useful as a
 * one-shot connectivity probe before wiring this into a real flow.
 */
export async function firecrawlHealthCheck(): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await scrapeUrl("https://example.com", {
      formats: ["markdown"],
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      detail: `Scraped example.com (${result.markdown?.length ?? 0} markdown chars).`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
