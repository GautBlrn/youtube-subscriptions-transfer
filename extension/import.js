"use strict";

const csvInput = document.getElementById("csvFile");
const startBtn = document.getElementById("start");
const statusEl = document.getElementById("status");

async function findYouTubeTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  if (!tabs.length) return null;
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0];
}

async function subscribe(tabId, id, authHeader, apiKey, clientVersion) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, func: subscribeOne,
    args: [id, authHeader, apiKey, clientVersion],
  });
  return result;
}

async function runImport() {
  startBtn.disabled = true;
  try {
    const file = csvInput.files && csvInput.files[0];
    if (!file) { setStatus(statusEl, "Pick a subscriptions.csv first.", "err"); return; }

    const ids = channelIdsFromCsv(await readFile(file));
    if (!ids.length) { setStatus(statusEl, "No channel IDs found in that CSV.", "err"); return; }

    const tab = await findYouTubeTab();
    if (!tab) {
      setStatus(statusEl, "Open youtube.com in another tab (logged in with the destination account), then retry.", "err");
      return;
    }

    const [{ result: cfg }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: getYtConfig,
    });
    if (!cfg || !cfg.apiKey || !cfg.clientVersion) {
      setStatus(statusEl, "YouTube config not found. Reload the youtube.com tab and retry.", "err");
      return;
    }

    let authHeader;
    try { authHeader = await buildAuthHeader(); }
    catch (e) { setStatus(statusEl, "Could not read your Google session. Are you logged in?", "err"); return; }

    const done = await loadDone();
    const pending = ids.filter((id) => !done.has(id));
    const total = pending.length;
    if (!total) { setStatus(statusEl, `All ${ids.length} channels already imported.`, "ok"); return; }

    let ok = 0, skipped = 0, failed = 0;
    for (let i = 0; i < pending.length; i++) {
      const id = pending[i];
      setStatus(statusEl, `Subscribing ${i + 1}/${total}…  (${ok} done, ${skipped} skipped, ${failed} failed)`);

      if (i > 0 && i % 100 === 0) {
        try { authHeader = await buildAuthHeader(); } catch (e) {}
      }

      let res = await subscribe(tab.id, id, authHeader, cfg.apiKey, cfg.clientVersion);
      if (res && res.auth) {
        try { authHeader = await buildAuthHeader(); } catch (e) {}
        res = await subscribe(tab.id, id, authHeader, cfg.apiKey, cfg.clientVersion);
      }

      if (res && res.ok) {
        ok++; done.add(id); await saveDone(done);
      } else if (res && /already|duplicate/i.test(res.reason || "")) {
        skipped++; done.add(id); await saveDone(done);
      } else {
        failed++;
        console.warn("subscribe failed", id, res);
      }
      await new Promise((r) => setTimeout(r, SUBSCRIBE_DELAY_MS));
    }

    setStatus(statusEl,
      `Done. ${ok} subscribed, ${skipped} already there, ${failed} failed` +
      (failed ? " (see the console for details)." : "."),
      failed ? "err" : "ok");
  } catch (err) {
    setStatus(statusEl, "Error: " + ((err && err.message) || String(err)), "err");
  } finally {
    startBtn.disabled = false;
  }
}

startBtn.addEventListener("click", runImport);
document.getElementById("reset").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.storage.local.remove(DONE_KEY);
  setStatus(statusEl, "Import progress reset.", "muted");
});
