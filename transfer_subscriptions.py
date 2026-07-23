"""Transfer YouTube subscriptions from a Google Takeout CSV to another account.

Uses the official YouTube Data API v3 (subscriptions.insert) instead of browser
automation. Authentication is a standard OAuth 2.0 desktup flow: the target
account is the one you log into when the browser opens.

Quota note: subscriptions.insert costs 50 units and the default daily quota is
10_000 units, i.e. ~200 subscriptions/day. The script is resumable: already
processed channels are stored in a checkpoint file, so you can re-run it on the
next day (or after a quota reset) and it picks up where it left off.

Setup (one time):
  1. Create a project on https://console.cloud.google.com/
  2. Enable "YouTube Data API v3".
  3. Configure the OAuth consent screen (External, add your target account as a
     test user).
  4. Create an OAuth client ID of type "Desktop app", download the JSON as
     client_secret.json next to this script.
  5. python -m venv .venv && source .venv/bin/activate
     pip install -r requirements.txt

Run:
  python transfer_subscriptions.py --csv subscriptions.csv
  # log in with the DESTINATION account in the browser window that opens.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
import time
from pathlib import Path

from google.auth.transport.requests import Request
from google.auth.exceptions import RefreshError
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# Write scope: required to create subscriptions on the authenticated account.
SCOPES: list[str] = ["https://www.googleapis.com/auth/youtube"]

# Cost of one subscriptions.insert call, for the local quota estimate only.
INSERT_COST_UNITS: int = 50

# Reasons that mean "no point retrying this channel": mark it as processed.
PERMANENT_FAILURE_REASONS: frozenset[str] = frozenset(
    {"subscriptionDuplicate", "channelNotFound", "subscriberNotFound"}
)

# Reasons that mean "stop for today, quota is gone": halt without marking.
QUOTA_REASONS: frozenset[str] = frozenset({"quotaExceeded", "dailyLimitExceeded"})

_CHANNEL_ID_RE = re.compile(r"/channel/(UC[0-9A-Za-z_-]{22})")


def authenticate(client_secret: Path, token_path: Path) -> Credentials:
    """Return valid OAuth credentials, running the desktop flow if needed.

    A cached token is reused and silently refreshed when possible; otherwise the
    browser-based consent flow is launched.
    """
    creds: Credentials | None = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            token_path.write_text(creds.to_json(), encoding="utf-8")
            return creds
        except RefreshError:
            pass  # fall through to a fresh interactive flow

    if not client_secret.exists():
        sys.exit(f"OAuth client secret not found: {client_secret}")

    flow = InstalledAppFlow.from_client_secrets_file(str(client_secret), SCOPES)
    creds = flow.run_local_server(port=0)
    token_path.write_text(creds.to_json(), encoding="utf-8")
    return creds


def extract_channel_id(row: dict[str, str]) -> str | None:
    """Extract a channel id (UC...) from a Takeout CSV row.

    Prefers an explicit id column and falls back to parsing the channel URL,
    since Takeout's column naming has changed over time.
    """
    for key, value in row.items():
        if value and key.strip().lower() in {"channel id", "channelid"}:
            return value.strip()

    for key, value in row.items():
        if value and "url" in key.strip().lower():
            match = _CHANNEL_ID_RE.search(value)
            if match:
                return match.group(1)
    return None


def load_channel_ids(csv_path: Path) -> list[str]:
    """Read the Takeout CSV and return the de-duplicated list of channel ids."""
    seen: set[str] = set()
    ids: list[str] = []
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            channel_id = extract_channel_id(row)
            if channel_id and channel_id not in seen:
                seen.add(channel_id)
                ids.append(channel_id)
    return ids


def load_checkpoint(path: Path) -> set[str]:
    """Return the set of channel ids already handled in a previous run."""
    if not path.exists():
        return set()
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def append_checkpoint(path: Path, channel_id: str) -> None:
    """Persist one handled channel id immediately (crash-safe append)."""
    with path.open("a", encoding="utf-8") as handle:
        handle.write(channel_id + "\n")


def subscribe(youtube, channel_id: str) -> None:
    """Subscribe the authenticated account to channel_id.

    Raises HttpError on API failure so the caller can inspect the reason.
    """
    youtube.subscriptions().insert(
        part="snippet",
        body={
            "snippet": {
                "resourceId": {"kind": "youtube#channel", "channelId": channel_id}
            }
        },
    ).execute()


def error_reason(error: HttpError) -> str:
    """Best-effort extraction of the machine-readable reason from an HttpError."""
    try:
        details = error.error_details  # type: ignore[attr-defined]
        if details:
            return str(details[0].get("reason", ""))
    except (AttributeError, IndexError, KeyError):
        pass
    return ""


def run(
    channel_ids: list[str],
    youtube,
    checkpoint_path: Path,
    delay: float,
    max_per_run: int | None,
) -> None:
    """Subscribe to every pending channel, handling quota and duplicates."""
    done = load_checkpoint(checkpoint_path)
    pending = [cid for cid in channel_ids if cid not in done]

    print(f"{len(channel_ids)} channels in CSV, {len(pending)} pending.")
    if max_per_run is not None:
        pending = pending[:max_per_run]
        print(f"Capping this run to {len(pending)} channels.")

    subscribed = 0
    for index, channel_id in enumerate(pending, start=1):
        try:
            subscribe(youtube, channel_id)
            append_checkpoint(checkpoint_path, channel_id)
            subscribed += 1
            print(f"[{index}/{len(pending)}] subscribed: {channel_id}")
        except HttpError as error:
            reason = error_reason(error)
            if reason in QUOTA_REASONS:
                print(
                    f"Quota exhausted after {subscribed} new subscriptions this run. "
                    "Re-run tomorrow to continue."
                )
                break
            if reason in PERMANENT_FAILURE_REASONS:
                append_checkpoint(checkpoint_path, channel_id)
                label = "already subscribed" if reason == "subscriptionDuplicate" else reason
                print(f"[{index}/{len(pending)}] skipped ({label}): {channel_id}")
            else:
                # Transient/unknown: log and leave it for a later run.
                print(f"[{index}/{len(pending)}] error ({reason or error}): {channel_id}")
                time.sleep(delay * 2)
                continue

        time.sleep(delay)

    print(
        f"Done. {subscribed} new subscriptions this run "
        f"(~{subscribed * INSERT_COST_UNITS} quota units used)."
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, required=True, help="Takeout subscriptions.csv")
    parser.add_argument("--client-secret", type=Path, default=Path("client_secret.json"))
    parser.add_argument("--token", type=Path, default=Path("token.json"))
    parser.add_argument("--checkpoint", type=Path, default=Path("processed_channels.txt"))
    parser.add_argument(
        "--delay",
        type=float,
        default=0.5,
        help="Seconds between calls (be gentle, the API is not the bottleneck; quota is).",
    )
    parser.add_argument(
        "--max-per-run",
        type=int,
        default=None,
        help="Optional cap on subscriptions per run (default: until quota or list end).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.csv.exists():
        sys.exit(f"CSV not found: {args.csv}")

    channel_ids = load_channel_ids(args.csv)
    if not channel_ids:
        sys.exit("No channel ids found in the CSV (check the column names).")

    creds = authenticate(args.client_secret, args.token)
    youtube = build("youtube", "v3", credentials=creds)
    run(channel_ids, youtube, args.checkpoint, args.delay, args.max_per_run)


if __name__ == "__main__":
    main()
