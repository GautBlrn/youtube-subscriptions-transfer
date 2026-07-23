# youtube-subscriptions-transfer

Move your YouTube subscriptions from one Google account to another, using the
official **YouTube Data API v3** (no browser automation, no scraping, nothing
against YouTube's terms of service).

You export your subscriptions from the source account with Google Takeout, then
run this script against the destination account. It reads the channel list from
the CSV and re-subscribes the destination account to each channel.

## Why a script and not a button

YouTube has no built-in "transfer my subscriptions" feature. The usual advice is
to re-subscribe by hand, which is painful past a handful of channels. This tool
does it through the supported API, is **resumable**, and respects the daily API
quota.

## How it works

- Reads channel IDs from a Google Takeout `subscriptions.csv`.
- Calls `subscriptions.insert` on the destination account (OAuth 2.0 desktop flow).
- Writes every handled channel to a checkpoint file, so a re-run continues where
  it stopped (channels already done, duplicates, and dead channels are skipped).

### About the quota

`subscriptions.insert` costs **50 quota units**, and a fresh Google Cloud project
gets **10,000 units/day** by default. That is about **200 subscriptions per day**.
If you have more, the script stops cleanly when the quota is gone and you re-run
it the next day. It picks up automatically thanks to the checkpoint.

## Setup

### 1. Export subscriptions from the SOURCE account

1. Go to [Google Takeout](https://takeout.google.com/).
2. Deselect everything, then select **YouTube and YouTube Music**.
3. In "All YouTube data included", keep only **subscriptions**.
4. Export, download the archive, and locate `subscriptions.csv`.

The CSV looks like [`subscriptions.sample.csv`](subscriptions.sample.csv).
Column names vary by account language (English `Channel Id` / French
`ID des chaînes` / etc.); the script handles both the explicit ID column and the
channel URL, so any Takeout export works.

### 2. Create a Google Cloud project (destination account)

1. Create a project on the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **YouTube Data API v3**.
3. Configure the **OAuth consent screen** (User type: External). Add your
   **destination** Google account as a **test user**.
4. Create an **OAuth client ID** of type **Desktop app**, download the JSON, and
   save it next to the script as `client_secret.json`.

### 3. Install

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Usage

```bash
python transfer_subscriptions.py --csv subscriptions.csv
```

A browser window opens: **log in with the DESTINATION account** (the one that
should receive the subscriptions). The token is cached in `token.json` for later
runs.

If you hit the daily quota, just run the same command again the next day.

### Options

| Flag | Default | Description |
|---|---|---|
| `--csv` | *(required)* | Path to the Takeout `subscriptions.csv`. |
| `--client-secret` | `client_secret.json` | OAuth client secret file. |
| `--token` | `token.json` | Where the cached OAuth token is stored. |
| `--checkpoint` | `processed_channels.txt` | Resume file of handled channels. |
| `--delay` | `0.5` | Seconds between API calls. |
| `--max-per-run` | *(none)* | Cap subscriptions per run (e.g. to stay under quota). |

## Security notes

- `client_secret.json` and `token.json` grant write access to a YouTube account.
  They are git-ignored on purpose. **Never commit or share them.**
- Your own `subscriptions.csv` and `processed_channels.txt` are git-ignored too
  (they are personal data). Only `subscriptions.sample.csv` is tracked.

## License

[MIT](LICENSE)
