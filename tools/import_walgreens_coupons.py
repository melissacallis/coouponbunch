#!/usr/bin/env python3
"""Import Walgreens manufacturer coupons scraped by
tools/bookmarklet/scrape-walgreens-coupons.src.js into walgreens_coupons.json.

Usage:
    python tools/import_walgreens_coupons.py                  # reads ~/Downloads/walgreens-coupons-raw.json
    python tools/import_walgreens_coupons.py --file path.json
    python tools/import_walgreens_coupons.py --yes             # skip the commit confirmation prompt
    python tools/import_walgreens_coupons.py --no-commit       # write walgreens_coupons.json only, don't touch git
"""

import argparse
import json
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

DEFAULT_INPUT = pathlib.Path.home() / "Downloads" / "walgreens-coupons-raw.json"
OUTPUT_PATH = pathlib.Path(__file__).resolve().parent.parent / "walgreens_coupons.json"


def run_git(*args):
    subprocess.run(["git", *args], check=True)


def load_raw(path):
    if not path.exists():
        print(f"Error: {path} not found.", file=sys.stderr)
        print(
            "Run the Walgreens coupons bookmarklet first (tools/bookmarklet/README.md), "
            "or pass --file to point at wherever it downloaded.",
            file=sys.stderr,
        )
        sys.exit(1)
    with open(path) as f:
        payload = json.load(f)
    coupons = payload.get("coupons", [])
    if not coupons:
        print(f"Error: {path} has no coupons in it.", file=sys.stderr)
        sys.exit(1)
    return payload, coupons


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=pathlib.Path, default=DEFAULT_INPUT)
    parser.add_argument("--yes", action="store_true", help="commit and push without asking")
    parser.add_argument("--no-commit", action="store_true", help="write walgreens_coupons.json only")
    args = parser.parse_args()

    payload, coupons = load_raw(args.file)

    output = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source_url": payload.get("source_url"),
        "source": "bookmarklet",
        "coupons": coupons,
    }
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote walgreens_coupons.json: {len(coupons)} coupon(s).")

    if args.no_commit:
        return

    should_commit = args.yes
    if not should_commit:
        answer = input("Commit and push walgreens_coupons.json now? [y/N] ").strip().lower()
        should_commit = answer == "y"

    if not should_commit:
        print("Left walgreens_coupons.json updated locally, uncommitted.")
        return

    try:
        run_git("add", "walgreens_coupons.json")
        result = subprocess.run(["git", "diff", "--cached", "--quiet"])
        if result.returncode == 0:
            print("No changes to commit.")
            return
        run_git("commit", "-m", "Update Walgreens coupons (bookmarklet import)")
        run_git("push")
        print("Committed and pushed.")
    except subprocess.CalledProcessError as e:
        print(f"git command failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
