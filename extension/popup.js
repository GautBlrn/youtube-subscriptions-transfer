"use strict";

const exportBtn = document.getElementById("export");
const exportStatus = document.getElementById("exportStatus");
const openImportBtn = document.getElementById("openImport");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function waitForComplete(tabId) {
  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureTab(tab, targetUrl) {
  // Must be on the exact target page (feed/channels), not just any YouTube page:
  // the subscription list only lives in that page's initial data.
  if (tab.url && tab.url.split("?")[0].startsWith(targetUrl)) return tab;
  await chrome.tabs.update(tab.id, { url: targetUrl });
  await waitForComplete(tab.id);
  await new Promise((r) => setTimeout(r, 1200));
  return await chrome.tabs.get(tab.id);
}

function toCsv(rows) {
  const esc = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ["Channel Id,Channel Url,Channel Title"];
  for (const { id, title } of rows) {
    lines.push([esc(id), esc("http://www.youtube.com/channel/" + id), esc(title)].join(","));
  }
  return lines.join("\n") + "\n";
}

async function runExport() {
  exportBtn.disabled = true;
  setStatus(exportStatus, "Reading your subscriptions…");
  try {
    let tab = await getActiveTab();
    if (!isYouTube(tab && tab.url)) {
      setStatus(exportStatus, "Open youtube.com logged in with the source account, then retry.", "err");
      return;
    }
    tab = await ensureTab(tab, FEED_URL);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: collectSubscriptions,
    });
    if (!result || !result.length) {
      setStatus(exportStatus, "No subscriptions found. Are you logged in?", "err");
      return;
    }
    const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(toCsv(result));
    await chrome.downloads.download({ url: dataUrl, filename: "subscriptions.csv", saveAs: true });
    setStatus(exportStatus, `Exported ${result.length} subscriptions.`, "ok");
  } catch (err) {
    const msg = err && err.message === "NOT_READY"
      ? "Page not ready. Reload youtube.com/feed/channels and retry."
      : "Error: " + ((err && err.message) || String(err));
    setStatus(exportStatus, msg, "err");
  } finally {
    exportBtn.disabled = false;
  }
}

exportBtn.addEventListener("click", runExport);
openImportBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("import.html") });
  window.close();
});
