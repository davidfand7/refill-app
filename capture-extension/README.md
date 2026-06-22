# Capture to SmartSpa — browser extension (Capture Lane P1)

One-click capture of a manufacturer-portal price page → your SmartSpa
**Verified pricing** inbox. Credential-free: it screenshots the page *you're*
already logged into and sends it with your SmartSpa token. SmartSpa never logs
into the manufacturer and never stores a portal password.

## Install (side-load, for the Rejuv test)

1. Open `chrome://extensions` (Chrome/Edge/Brave).
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** → select this `capture-extension/` folder.
4. Pin the extension (puzzle-piece icon → pin "Capture to SmartSpa").

## One-time setup

1. In SmartSpa: **Recognition → Rewards → Hands-free auto-import → Option B → Copy** (your per-spa token).
2. Click the extension icon → paste the token → **Save token**.

## Use

1. Log into a manufacturer portal (Allergan APP, Galderma ASPIRE, Evolus…) and open the **"Your Price"** page.
2. Click the **Capture to SmartSpa** icon → **Capture this page**.
3. It screenshots the visible tab, reads the prices, and stages a batch in **Verified pricing → Awaiting review** — confirm there, same as an upload.

## How it works

`captureVisibleTab` (granted by `activeTab` on click) → base64 PNG →
`POST https://smartspa.app/api/ingest/portal-capture { token, images, pageUrl, pageTitle, captureId }`
→ token resolves to your tenant → shared `ingestPortalImport` → review inbox.

Multi-screen portals: click **Capture this page** on each screen; each stages
its own review (Phase 2 will batch them together).

## Notes / roadmap

- P1 captures stage as `source='upload'` (show 📷 in the inbox). A distinct
  `source='capture'` tag is a fast-follow.
- Viewport-only capture in P1; full-page scroll-stitch is Phase 2.
- Manufacturer is auto-detected from the page title/URL when possible.
