#!/usr/bin/env python3
"""Import Target gift-card products scraped by
tools/bookmarklet/scrape-target-products.src.js into target_products.json.

Usage:
    python tools/import_target_products.py                  # reads ~/Downloads/target-products-raw.json
    python tools/import_target_products.py --file path.json
"""

import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

DEFAULT_INPUT = pathlib.Path.home() / "Downloads" / "target-products-raw.json"
OUTPUT_PATH = pathlib.Path(__file__).resolve().parent.parent / "target_products.json"


def load_raw(path):
    if not path.exists():
        print(f"Error: {path} not found.", file=sys.stderr)
        print(
            "Run the Target products bookmarklet first (tools/bookmarklet/README.md), "
            "or pass --file to point at wherever it downloaded.",
            file=sys.stderr,
        )
        sys.exit(1)
    with open(path) as f:
        payload = json.load(f)
    products = payload.get("products", [])
    if not products:
        print(f"Error: {path} has no products in it.", file=sys.stderr)
        sys.exit(1)
    return payload, products


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=pathlib.Path, default=DEFAULT_INPUT)
    args = parser.parse_args()

    payload, products = load_raw(args.file)

    output = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source_url": payload.get("source_url"),
        "source": "bookmarklet",
        "products": products,
    }
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote target_products.json: {len(products)} gift-card product(s).")


if __name__ == "__main__":
    main()
