// Capture to SmartSpa — popup logic (MV3).
// Screenshots the visible tab (the owner's own authenticated portal view) and
// POSTs it to /api/ingest/portal-capture with the spa's token. No portal
// credential is ever read or stored — only the SmartSpa token, in local storage.

const API = "https://smartspa.app/api/ingest/portal-capture";

const tokenEl = document.getElementById("token");
const saveEl = document.getElementById("save");
const capEl = document.getElementById("capture");
const statusEl = document.getElementById("status");

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || "";
}

// Restore a saved token.
chrome.storage.local.get(["smartspaToken"], (r) => {
  if (r && r.smartspaToken) tokenEl.value = r.smartspaToken;
});

saveEl.addEventListener("click", () => {
  const token = tokenEl.value.trim();
  chrome.storage.local.set({ smartspaToken: token }, () =>
    setStatus(token ? "Token saved." : "Token cleared.", "ok"),
  );
});

capEl.addEventListener("click", async () => {
  const token = tokenEl.value.trim();
  if (!token) {
    setStatus("Paste your SmartSpa token first.", "err");
    return;
  }
  // Persist on use so it's there next time.
  chrome.storage.local.set({ smartspaToken: token });

  capEl.disabled = true;
  setStatus("Capturing the page…", "");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    const base64 = String(dataUrl).split(",")[1];
    if (!base64) throw new Error("couldn't read the screenshot");

    const captureId =
      (crypto && crypto.randomUUID && crypto.randomUUID()) || "cap_" + Date.now();

    setStatus("Reading prices…", "");
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        images: [{ data: base64, mediaType: "image/png" }],
        pageUrl: (tab && tab.url) || "",
        pageTitle: (tab && tab.title) || "",
        captureId,
      }),
    });
    const json = await res.json().catch(() => ({}));

    if (res.ok && json && json.ok) {
      const dup = json.deduped ? " (already sent)" : "";
      setStatus(`Sent ✓ — ${json.matched}/${json.prices} matched${dup}. Review in SmartSpa.`, "ok");
    } else {
      const why = (json && (json.reason || json.error)) || ("HTTP " + res.status);
      setStatus("Couldn't send: " + why, "err");
    }
  } catch (e) {
    setStatus("Capture failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    capEl.disabled = false;
  }
});
