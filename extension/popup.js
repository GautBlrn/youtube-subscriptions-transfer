"use strict";

const FEED_URL = "https://www.youtube.com/feed/channels";
const runBtn = document.getElementById("run");
const statusEl = document.getElementById("status");

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "muted";
}

/**
 * Runs INSIDE the youtube.com page (injected via chrome.scripting).
 * Reads the initial data, then pages through the internal browse endpoint with
 * the user's own cookies to collect every subscription. Read-only.
 * Returns an array of { id, title }.
 */
async function collectSubscriptions() {
  const html = document.documentElement.innerHTML;

  const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
  const clientVersion =
    (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] ||
    (html.match(/"clientVersion":"([^"]+)"/) || [])[1];
  if (!apiKey || !clientVersion) {
    throw new Error("NOT_READY");
  }

  // Extract a balanced JSON object that follows a marker in the page source.
  function extractJson(source, marker) {
    const start = source.indexOf(marker);
    if (start === -1) return null;
    let i = source.indexOf("{", start);
    if (i === -1) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < source.length; j++) {
      const ch = source[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(i, j + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  function titleText(title) {
    if (!title) return "";
    if (typeof title === "string") return title;
    if (title.simpleText) return title.simpleText;
    if (Array.isArray(title.runs)) return title.runs.map((r) => r.text).join("");
    return "";
  }

  const UC_RE = /^UC[0-9A-Za-z_-]{22}$/;

  // Walk any structure: record channel entries, capture a continuation token.
  function harvest(node, out, contRef) {
    if (Array.isArray(node)) {
      for (const item of node) harvest(item, out, contRef);
      return;
    }
    if (!node || typeof node !== "object") return;

    if (typeof node.channelId === "string" && UC_RE.test(node.channelId) && node.title) {
      const title = titleText(node.title);
      if (title && !out.has(node.channelId)) out.set(node.channelId, title);
    }

    const token =
      node.continuationItemRenderer &&
      node.continuationItemRenderer.continuationEndpoint &&
      node.continuationItemRenderer.continuationEndpoint.continuationCommand &&
      node.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    if (token) contRef.token = token;

    for (const key of Object.keys(node)) harvest(node[key], out, contRef);
  }

  const out = new Map();
  const contRef = { token: null };

  const initial = extractJson(html, "ytInitialData");
  if (!initial) throw new Error("NOT_READY");
  harvest(initial, out, contRef);

  const context = { client: { clientName: "WEB", clientVersion } };
  const endpoint =
    "https://www.youtube.com/youtubei/v1/browse?key=" +
    encodeURIComponent(apiKey) +
    "&prettyPrint=false";

  let guard = 0;
  while (contRef.token && guard < 300) {
    guard++;
    const token = contRef.token;
    contRef.token = null;
    const resp = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context, continuation: token }),
    });
    if (!resp.ok) break;
    const data = await resp.json();
    harvest(data, out, contRef);
  }

  return [...out.entries()].map(([id, title]) => ({ id, title }));
}

function toCsv(rows) {
  const escape = (value) => {
    const s = String(value);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ["Channel Id,Channel Url,Channel Title"];
  for (const { id, title } of rows) {
    const url = "http://www.youtube.com/channel/" + id;
    lines.push([escape(id), escape(url), escape(title)].join(","));
  }
  return lines.join("\n") + "\n";
}

async function ensureFeedTab(tab) {
  // Make sure the active tab is the subscriptions page before injecting.
  if (tab.url && tab.url.startsWith(FEED_URL)) return tab;

  setStatus("Opening your subscriptions page…");
  await chrome.tabs.update(tab.id, { url: FEED_URL });
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  // Give the SPA a moment to populate ytInitialData.
  await new Promise((r) => setTimeout(r, 1200));
  return await chrome.tabs.get(tab.id);
}

async function run() {
  runBtn.disabled = true;
  setStatus("Reading your subscriptions…");
  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https:\/\/www\.youtube\.com\//.test(tab.url)) {
      setStatus(
        "Open youtube.com and log in with the account to export first, then click again.",
        "err"
      );
      runBtn.disabled = false;
      return;
    }

    tab = await ensureFeedTab(tab);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectSubscriptions,
    });

    if (!result || result.length === 0) {
      setStatus(
        "No subscriptions found. Make sure you are logged in, then retry.",
        "err"
      );
      runBtn.disabled = false;
      return;
    }

    const csv = toCsv(result);
    const dataUrl =
      "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    await chrome.downloads.download({
      url: dataUrl,
      filename: "subscriptions.csv",
      saveAs: true,
    });

    setStatus(`Exported ${result.length} subscriptions to subscriptions.csv`, "ok");
  } catch (err) {
    const msg =
      err && err.message === "NOT_READY"
        ? "Page not ready. Reload youtube.com/feed/channels and retry."
        : "Error: " + (err && err.message ? err.message : String(err));
    setStatus(msg, "err");
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", run);
