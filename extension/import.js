"use strict";

const csvInput = document.getElementById("csvFile");
const startBtn = document.getElementById("start");
const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const barEl = document.getElementById("bar");
const pctEl = document.getElementById("pct");
const cSub = document.getElementById("cSub");
const cAlready = document.getElementById("cAlready");
const cFailed = document.getElementById("cFailed");

async function findYouTubeTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  if (!tabs.length) return null;
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0];
}

async function runInTab(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

const FEED = "https://www.youtube.com/feed/channels";

async function goToFeedChannels(tab) {
  if (tab.url && tab.url.split("?")[0].startsWith(FEED)) return tab;
  await chrome.tabs.update(tab.id, { url: FEED });
  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  await new Promise((r) => setTimeout(r, 1200));
  return await chrome.tabs.get(tab.id);
}

function setProgress(current, total) {
  const pct = total ? Math.round((current / total) * 100) : 0;
  barEl.style.width = pct + "%";
  pctEl.textContent = `${current} / ${total} (${pct}%)`;
}

async function runImport() {
  startBtn.disabled = true;
  try {
    const file = csvInput.files && csvInput.files[0];
    if (!file) { setStatus(statusEl, "Pick a subscriptions.csv first.", "err"); return; }

    const ids = channelIdsFromCsv(await readFile(file));
    if (!ids.length) { setStatus(statusEl, "No channel IDs found in that CSV.", "err"); return; }

    let tab = await findYouTubeTab();
    if (!tab) {
      setStatus(statusEl, "Open youtube.com in another tab (logged in with the destination account), then retry.", "err");
      return;
    }

    const cfg = await runInTab(tab.id, getYtConfig);
    if (!cfg || !cfg.apiKey || !cfg.clientVersion) {
      setStatus(statusEl, "YouTube config not found. Reload the youtube.com tab and retry.", "err");
      return;
    }
    if (!cfg.loggedIn) {
      setStatus(statusEl, "The youtube.com tab is not logged in. Log in with the destination account and retry.", "err");
      return;
    }

    let authHeader;
    try { authHeader = await buildAuthHeader(); }
    catch (e) { setStatus(statusEl, "Could not read your Google session. Are you logged in?", "err"); return; }

    setStatus(statusEl, "Checking which channels you already follow…");
    // Reuse the proven export mechanism: read the destination account's current
    // subscriptions from its own feed/channels page.
    let existing = new Set();
    try {
      tab = await goToFeedChannels(tab);
      const subs = await runInTab(tab.id, collectSubscriptions);
      existing = new Set((subs || []).map((s) => s.id));
    } catch (e) {
      console.warn("[import] could not read existing subscriptions", e);
    }

    const done = await loadDone();
    const pending = ids.filter((id) => !done.has(id));
    const total = pending.length;
    if (!total) { setStatus(statusEl, `All ${ids.length} channels already handled.`, "ok"); return; }

    progressWrap.classList.add("show");
    let ok = 0, already = 0, failed = 0;
    const render = () => { cSub.textContent = ok; cAlready.textContent = already; cFailed.textContent = failed; };

    for (let i = 0; i < pending.length; i++) {
      const id = pending[i];
      setProgress(i, total);
      setStatus(statusEl, `Working… ${i + 1} of ${total}`);

      if (existing.has(id)) {
        already++; done.add(id); await saveDone(done); render();
        continue;
      }

      if (i > 0 && i % 100 === 0) {
        try { authHeader = await buildAuthHeader(); } catch (e) {}
      }

      let res = await runInTab(tab.id, subscribeOne, [id, authHeader, cfg]);
      if (res && res.auth) {
        try { authHeader = await buildAuthHeader(); } catch (e) {}
        res = await runInTab(tab.id, subscribeOne, [id, authHeader, cfg]);
      }

      if (res && res.blocked) {
        setStatus(statusEl,
          "Requests are being blocked, likely by a content/ad blocker (uBlock, etc.). " +
          "Disable it on youtube.com and retry.", "err");
        return;
      }
      if (res && res.ok) {
        ok++; done.add(id); await saveDone(done);
      } else {
        failed++;
        console.warn("[import] subscribe failed", id, res);
      }
      render();
      await new Promise((r) => setTimeout(r, SUBSCRIBE_DELAY_MS));
    }

    setProgress(total, total);
    setStatus(statusEl,
      `Done. ${ok} subscribed, ${already} already there, ${failed} failed` +
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
  progressWrap.classList.remove("show");
  setStatus(statusEl, "Import progress reset.", "");
});
