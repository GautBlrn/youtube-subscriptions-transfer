# YouTube Subscriptions Transfer (browser extension)

A Chrome/Chromium (Manifest V3) extension that **exports** your YouTube
subscriptions to a CSV and **imports** them into another account, straight from
the browser, using your own logged-in session. No server, nothing leaves your
machine.

> Distributed here for load-unpacked install only, **not** on the Chrome Web
> Store (see the ToS note below).

## Two steps

### 1. Export (source account): read-only

Reads the subscription list of the logged-in account via YouTube's own page data
and internal browse endpoint (your session cookies), and downloads a
`subscriptions.csv` (`Channel Id,Channel Url,Channel Title`). It never writes.

### 2. Import (destination account): automated subscribe

Reads the CSV and subscribes the logged-in account to each channel by calling
YouTube's internal `subscription/subscribe` endpoint, signed with your session
(`SAPISIDHASH`), at a gentle pace. It is **resumable**: handled channels are kept
in the extension's local storage, so you can stop and restart (use *Reset import
progress* to start over). Channels you already follow are skipped.

## ⚠️ Terms of Service

Automating subscriptions is **against YouTube's Terms of Service**. This is meant
for migrating **your own** accounts, at a reasonable pace, at your own risk. That
is also why it is not published on the Chrome Web Store. If you want a
ToS-compliant import instead, use the [Python script](../README.md) (official
YouTube Data API), which is capped by the API's ~200 subscriptions/day quota.

## Permissions

- `youtube.com` and `*.google.com` host access: read the page config and the
  session cookie used to sign the subscribe calls.
- `cookies`: read the `SAPISID` cookie family to build the auth header.
- `scripting`, `activeTab`, `tabs`: run the collect/subscribe logic in your
  YouTube tab.
- `downloads`: save the exported CSV.
- `storage`: remember which channels were already imported (resume).

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.

## Use

1. **Export:** log in with the source account, click the icon, then
   *Export my subscriptions*.
2. **Import:** log in with the destination account (same browser, switch account
   or profile), click the icon, pick the CSV, then *Import from CSV*.

## Notes

- The import subscribes at ~3 channels/second. For very large lists, YouTube may
  temporarily rate-limit; if subscribes start failing, wait and re-run (progress
  resumes).
- The extension relies on YouTube's internal structures. If a future change
  breaks it, open an issue.
