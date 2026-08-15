#!/usr/bin/env python3
"""Import Target Circle/manufacturer coupons scraped by
tools/bookmarklet/scrape-target-coupons.src.js into target_coupons.json.

Usage:
    python tools/import_target_coupons.py                  # reads ~/Downloads/target-coupons-raw.json
    python tools/import_target_coupons.py --file path.json
"""

import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

DEFAULT_INPUT = pathlib.Path.home() / "Downloads" / "target-coupons-raw.json"
OUTPUT_PATH = pathlib.Path(__file__).resolve().parent.parent / "target_coupons.json"


def load_raw(path):
    if not path.exists():
        print(f"Error: {path} not found.", file=sys.stderr)
        print(
            "Run the Target coupons bookmarklet first (tools/bookmarklet/README.md), "
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

    print(f"Wrote target_coupons.json: {len(coupons)} coupon(s).")


if __name__ == "__main__":
    main()
