#!/usr/bin/env python3
"""Import prices scraped by tools/bookmarklet/scrape-prices.src.js into
prices.json. See tools/bookmarklet/README.md.

Usage:
    python tools/import_prices.py                  # reads ~/Downloads/heb-prices-raw.json
    python tools/import_prices.py --file path.json
"""

import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

DEFAULT_INPUT = pathlib.Path.home() / "Downloads" / "heb-prices-raw.json"
PRICES_PATH = pathlib.Path(__file__).resolve().parent.parent / "prices.json"


def load_raw(path):
    if not path.exists():
        print(f"Error: {path} not found.", file=sys.stderr)
        print(
            "Run the price bookmarklet first (tools/bookmarklet/README.md), or pass "
            "--file to point at wherever it downloaded.",
            file=sys.stderr,
        )
        sys.exit(1)
    with open(path) as f:
        payload = json.load(f)
    if not payload.get("batches"):
        print(f"Error: {path} has no captured product batches in it.", file=sys.stderr)
        sys.exit(1)
    return payload


def load_existing_prices():
    if PRICES_PATH.exists():
        with open(PRICES_PATH) as f:
            return json.load(f)
    return {"updated_at": None, "store_id": None, "source": None, "products": {}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=pathlib.Path, default=DEFAULT_INPUT)
    args = parser.parse_args()

    payload = load_raw(args.file)
    existing = load_existing_prices()

    products = existing.get("products", {})
    total_new = 0
    for batch in payload["batches"]:
        term = batch.get("search_term", "unknown")
        entries = []
        for p in batch.get("products", []):
            entries.append(
                {
                    "name": p.get("name", ""),
                    "price": p.get("price"),
                    "size": p.get("size"),
                    "unit_price": p.get("unit_price"),
                    "scraped_at": payload.get("scraped_at"),
                }
            )
        products[term] = entries
        total_new += len(entries)
        print(f"  {term}: {len(entries)} product(s)")

    existing["products"] = products
    existing["updated_at"] = datetime.now(timezone.utc).isoformat()
    existing["store_id"] = payload.get("store_id") or existing.get("store_id")
    existing["source"] = "bookmarklet"

    with open(PRICES_PATH, "w") as f:
        json.dump(existing, f, indent=2)

    print(f"Wrote prices.json: {total_new} products across {len(payload['batches'])} search term(s).")


if __name__ == "__main__":
    main()
