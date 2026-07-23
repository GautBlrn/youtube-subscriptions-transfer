# YouTube Subscriptions Exporter (browser extension)

A small Chrome/Chromium (Manifest V3) extension that exports **your own**
YouTube subscriptions to a `subscriptions.csv` in the exact format the
[transfer script](../README.md) expects. It replaces the manual Google Takeout
step.

## What it does (and doesn't)

- **Read-only.** It reads the subscription list of the account you are logged
  into, using YouTube's own page data and internal browse endpoint with your
  existing session cookies. It never writes, subscribes, or unsubscribes.
- It does **not** use the YouTube Data API, so there is **no quota and no Google
  Cloud setup** for the export step. (The *writing* side still uses the API, via
  the transfer script.)
- It collects the canonical channel IDs (`UC…`) and titles, and downloads a CSV
  with columns `Channel Id,Channel Url,Channel Title`.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.

## Use

1. Log in to YouTube with the **source** account (the one to export from).
2. Click the extension icon.
3. Click **Export my subscriptions**. The extension opens your subscriptions
   page if needed, collects every channel, and downloads `subscriptions.csv`.
4. Feed that CSV to the transfer script, logging in with the **destination**
   account:
   ```bash
   python transfer_subscriptions.py --csv subscriptions.csv
   ```

## Notes

- Nothing leaves your browser. The CSV is built locally and downloaded to your
  machine; the extension has no server and makes no third-party requests.
- The export relies on YouTube's internal page structure. If a future YouTube
  change breaks it, open an issue.
