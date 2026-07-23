"use strict";

/* Shared constants and helpers for both the popup and the import page. */

const FEED_URL = "https://www.youtube.com/feed/channels";
const YT_URL = "https://www.youtube.com/";
const ORIGIN = "https://www.youtube.com";
const SUBSCRIBE_DELAY_MS = 350;
const DONE_KEY = "importedChannels";
const UC_RE = /^UC[0-9A-Za-z_-]{22}$/;
const URL_ID_RE = /\/channel\/(UC[0-9A-Za-z_-]{22})/;

function setStatus(node, text, cls) {
  node.textContent = text;
  node.className = "status " + (cls || "muted");
}

function isYouTube(url) {
  return !!url && /^https:\/\/www\.youtube\.com\//.test(url);
}

/* ---------------- injected into youtube.com ---------------- */

function getYtConfig() {
  const html = document.documentElement.innerHTML;
  const pick = (re) => (html.match(re) || [])[1] || null;
  return {
    apiKey: pick(/"INNERTUBE_API_KEY":"([^"]+)"/),
    clientVersion:
      pick(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) ||
      pick(/"clientVersion":"([^"]+)"/),
    // Which signed-in account this tab is showing (0 = first account).
    sessionIndex: pick(/"SESSION_INDEX":"?(\d+)"?/) || "0",
    // Set for brand / delegated accounts; used as X-Goog-PageId.
    delegatedSessionId: pick(/"DELEGATED_SESSION_ID":"([^"]+)"/),
    loggedIn: /"LOGGED_IN":\s*true/.test(html),
  };
}

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

  const UCRE = /^UC[0-9A-Za-z_-]{22}$/;

  function harvest(node, out, contRef) {
    if (Array.isArray(node)) {
      for (const item of node) harvest(item, out, contRef);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (typeof node.channelId === "string" && UCRE.test(node.channelId) && node.title) {
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

async function subscribeOne(channelId, authHeader, cfg) {
  try {
    const url =
      "https://www.youtube.com/youtubei/v1/subscription/subscribe?key=" +
      encodeURIComponent(cfg.apiKey) + "&prettyPrint=false";
    const headers = {
      "Content-Type": "application/json",
      Authorization: authHeader,
      "X-Origin": "https://www.youtube.com",
      "X-Goog-AuthUser": String(cfg.sessionIndex || "0"),
    };
    if (cfg.delegatedSessionId) headers["X-Goog-PageId"] = cfg.delegatedSessionId;

    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: cfg.clientVersion } },
        channelIds: [channelId],
        params: "EgIIAhgB",
      }),
    });
    const text = await resp.text();
    const body = text.slice(0, 600);

    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, auth: true, status: resp.status, reason: body };
    }
    if (!resp.ok) return { ok: false, status: resp.status, reason: body };

    let data = null;
    try { data = JSON.parse(text); } catch (e) {}
    if (data && data.error) {
      return { ok: false, status: data.error.code, reason: data.error.message, body };
    }
    // Real confirmation: YouTube echoes the new subscribe-button state.
    const confirmed = /"subscribed"\s*:\s*true/.test(text);
    return { ok: confirmed, confirmed, status: resp.status, body };
  } catch (e) {
    // A content/ad blocker (uBlock, etc.) makes fetch reject before it leaves.
    const msg = String((e && e.message) || e);
    const blocked = /Failed to fetch|ERR_BLOCKED|NetworkError/i.test(msg);
    return { ok: false, status: 0, blocked, reason: msg };
  }
}

/* ---------------- auth (runs in extension page) ---------------- */

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getGoogleCookie(name) {
  const c = await chrome.cookies.get({ url: "https://www.google.com", name });
  return c ? c.value : null;
}

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

/* ---------------- CSV ---------------- */

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

/* ---------------- progress storage ---------------- */

async function loadDone() {
  const got = await chrome.storage.local.get(DONE_KEY);
  return new Set(got[DONE_KEY] || []);
}
async function saveDone(set) {
  await chrome.storage.local.set({ [DONE_KEY]: [...set] });
}
