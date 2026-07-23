"use strict";

const FEED_URL = "https://www.youtube.com/feed/channels";
const YT_URL = "https://www.youtube.com/";
const ORIGIN = "https://www.youtube.com";
const SUBSCRIBE_DELAY_MS = 350;
const DONE_KEY = "importedChannels";

const el = (id) => document.getElementById(id);
const exportBtn = el("export");
const importBtn = el("import");
const csvInput = el("csvFile");
const exportStatus = el("exportStatus");
const importStatus = el("importStatus");

function status(node, text, cls) {
  node.textContent = text;
  node.className = "status " + (cls || "muted");
}

/* ------------------------------------------------------------------ */
/* Injected into youtube.com: read INNERTUBE config from the page.     */
/* ------------------------------------------------------------------ */
function getYtConfig() {
  const html = document.documentElement.innerHTML;
  const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || null;
  const clientVersion =
    (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] ||
    (html.match(/"clientVersion":"([^"]+)"/) || [])[1] ||
    null;
  return { apiKey, clientVersion };
}

/* ------------------------------------------------------------------ */
/* Injected into youtube.com: collect all subscriptions (read-only).   */
/* ------------------------------------------------------------------ */
async function collectSubscriptions() {
  const html = document.documentElement.innerHTML;
  const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
  const clientVersion =
    (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] ||
    (html.match(/"clientVersion":"([^"]+)"/) || [])[1];
  if (!apiKey || !clientVersion) throw new Error("NOT_READY");

  function extractJson(source, marker) {
    const start = source.indexOf(marker);
    if (start === -1) return null;
    const i = source.indexOf("{", start);
    if (i === -1) return null;
    let depth = 0, inStr = false, esc = false;
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
          try { return JSON.parse(source.slice(i, j + 1)); } catch (e) { return null; }
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

  function harvest(node, out, contRef) {
    if (Array.isArray(node)) {
      for (const item of node) harvest(item, out, contRef);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (typeof node.channelId === "string" && UC_RE.test(node.channelId) && node.title) {
      const t = titleText(node.title);
      if (t && !out.has(node.channelId)) out.set(node.channelId, t);
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
    encodeURIComponent(apiKey) + "&prettyPrint=false";

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
    harvest(await resp.json(), out, contRef);
  }
  return [...out.entries()].map(([id, title]) => ({ id, title }));
}

/* ------------------------------------------------------------------ */
/* Injected into youtube.com: subscribe to a single channel.           */
/* ------------------------------------------------------------------ */
async function subscribeOne(channelId, authHeader, apiKey, clientVersion) {
  try {
    const url =
      "https://www.youtube.com/youtubei/v1/subscription/subscribe?key=" +
      encodeURIComponent(apiKey) + "&prettyPrint=false";
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        "X-Origin": "https://www.youtube.com",
        "X-Goog-AuthUser": "0",
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion } },
        channelIds: [channelId],
        params: "EgIIAhgB",
      }),
    });
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, auth: true, status: resp.status, reason: text.slice(0, 160) };
    }
    if (!resp.ok) return { ok: false, status: resp.status, reason: text.slice(0, 160) };
    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    if (data && data.error) {
      return { ok: false, status: data.error.code, reason: data.error.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 0, reason: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------------ */
/* Tab / auth helpers (run in the popup).                              */
/* ------------------------------------------------------------------ */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isYouTube(url) {
  return url && /^https:\/\/www\.youtube\.com\//.test(url);
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
  if (isYouTube(tab.url)) return tab;
  await chrome.tabs.update(tab.id, { url: targetUrl });
  await waitForComplete(tab.id);
  await new Promise((r) => setTimeout(r, 1200));
  return await chrome.tabs.get(tab.id);
}

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getGoogleCookie(name) {
  const c = await chrome.cookies.get({ url: "https://www.google.com", name });
  return c ? c.value : null;
}

// YouTube signs youtubei mutations with a SAPISIDHASH built from the
// Google-wide SAPISID cookie family. Same scheme the web client uses.
async function buildAuthHeader() {
  const ts = Math.floor(Date.now() / 1000);
  const specs = [
    ["SAPISIDHASH", "SAPISID"],
    ["SAPISID1PHASH", "__Secure-1PAPISID"],
    ["SAPISID3PHASH", "__Secure-3PAPISID"],
  ];
  const parts = [];
  for (const [label, cookieName] of specs) {
    const val = await getGoogleCookie(cookieName);
    if (val) {
      const hash = await sha1Hex(`${ts} ${val} ${ORIGIN}`);
      parts.push(`${label} ${ts}_${hash}`);
    }
  }
  if (parts.length === 0) throw new Error("NO_SAPISID");
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* CSV parsing (mirror of the Python script's column logic).           */
/* ------------------------------------------------------------------ */
function parseCsv(text) {
  const rows = [];
  let field = "", row = [], inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inStr = false;
      } else field += ch;
    } else if (ch === '"') inStr = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const UC_RE = /^UC[0-9A-Za-z_-]{22}$/;
const URL_ID_RE = /\/channel\/(UC[0-9A-Za-z_-]{22})/;

function channelIdsFromCsv(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idCol = header.findIndex((h) => h === "channel id" || h === "channelid" || h === "id des chaînes");
  const urlCol = header.findIndex((h) => h.includes("url"));

  const seen = new Set();
  const ids = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    let id = null;
    if (idCol !== -1 && cells[idCol] && UC_RE.test(cells[idCol].trim())) {
      id = cells[idCol].trim();
    } else if (urlCol !== -1 && cells[urlCol]) {
      const m = cells[urlCol].match(URL_ID_RE);
      if (m) id = m[1];
    }
    if (!id) {
      for (const cell of cells) {
        const m = (cell || "").match(URL_ID_RE);
        if (m) { id = m[1]; break; }
        if (UC_RE.test((cell || "").trim())) { id = cell.trim(); break; }
      }
    }
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/* ------------------------------------------------------------------ */
/* Export flow.                                                        */
/* ------------------------------------------------------------------ */
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
  status(exportStatus, "Reading your subscriptions…");
  try {
    let tab = await getActiveTab();
    if (!isYouTube(tab && tab.url)) {
      status(exportStatus, "Open youtube.com logged in with the source account, then retry.", "err");
      return;
    }
    tab = await ensureTab(tab, FEED_URL);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: collectSubscriptions,
    });
    if (!result || !result.length) {
      status(exportStatus, "No subscriptions found. Are you logged in?", "err");
      return;
    }
    const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(toCsv(result));
    await chrome.downloads.download({ url: dataUrl, filename: "subscriptions.csv", saveAs: true });
    status(exportStatus, `Exported ${result.length} subscriptions.`, "ok");
  } catch (err) {
    const msg = err && err.message === "NOT_READY"
      ? "Page not ready. Reload youtube.com/feed/channels and retry."
      : "Error: " + ((err && err.message) || String(err));
    status(exportStatus, msg, "err");
  } finally {
    exportBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Import flow.                                                        */
/* ------------------------------------------------------------------ */
async function loadDone() {
  const got = await chrome.storage.local.get(DONE_KEY);
  return new Set(got[DONE_KEY] || []);
}
async function saveDone(set) {
  await chrome.storage.local.set({ [DONE_KEY]: [...set] });
}

async function runImport() {
  importBtn.disabled = true;
  try {
    const file = csvInput.files && csvInput.files[0];
    if (!file) { status(importStatus, "Pick a subscriptions.csv first.", "err"); return; }

    const ids = channelIdsFromCsv(await readFile(file));
    if (!ids.length) { status(importStatus, "No channel IDs found in that CSV.", "err"); return; }

    let tab = await getActiveTab();
    if (!isYouTube(tab && tab.url)) {
      status(importStatus, "Open youtube.com logged in with the DESTINATION account, then retry.", "err");
      return;
    }
    tab = await ensureTab(tab, YT_URL);

    const [{ result: cfg }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: getYtConfig,
    });
    if (!cfg || !cfg.apiKey || !cfg.clientVersion) {
      status(importStatus, "YouTube config not found. Reload youtube.com and retry.", "err");
      return;
    }

    let authHeader;
    try { authHeader = await buildAuthHeader(); }
    catch (e) {
      status(importStatus, "Could not read your Google session. Are you logged in?", "err");
      return;
    }

    const done = await loadDone();
    const pending = ids.filter((id) => !done.has(id));
    const total = pending.length;
    if (!total) { status(importStatus, `All ${ids.length} channels already imported.`, "ok"); return; }

    let ok = 0, skipped = 0, failed = 0;
    for (let i = 0; i < pending.length; i++) {
      const id = pending[i];
      status(importStatus, `Subscribing ${i + 1}/${total}…  (+${ok} done)`);

      // Refresh the auth header periodically for long runs.
      if (i > 0 && i % 100 === 0) {
        try { authHeader = await buildAuthHeader(); } catch (e) {}
      }

      let [{ result: res }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: subscribeOne,
        args: [id, authHeader, cfg.apiKey, cfg.clientVersion],
      });

      if (res && res.auth) {
        // Auth likely expired: rebuild once and retry this channel.
        try { authHeader = await buildAuthHeader(); } catch (e) {}
        [{ result: res }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, func: subscribeOne,
          args: [id, authHeader, cfg.apiKey, cfg.clientVersion],
        });
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

    const cls = failed ? "err" : "ok";
    status(importStatus,
      `Done. ${ok} subscribed, ${skipped} already there, ${failed} failed.`, cls);
  } catch (err) {
    status(importStatus, "Error: " + ((err && err.message) || String(err)), "err");
  } finally {
    importBtn.disabled = false;
  }
}

exportBtn.addEventListener("click", runExport);
importBtn.addEventListener("click", runImport);
el("resetProgress").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.storage.local.remove(DONE_KEY);
  status(importStatus, "Import progress reset.", "muted");
});
