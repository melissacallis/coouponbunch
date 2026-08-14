#!/usr/bin/env python3
"""Import coupons scraped by tools/bookmarklet/scrape-coupons.src.js into
coupons.json. This is the primary/reliable data path — see
tools/bookmarklet/README.md.

Usage:
    python tools/import_coupons.py                  # reads ~/Downloads/heb-coupons-raw.json
    python tools/import_coupons.py --file path.json
    python tools/import_coupons.py --yes             # skip the commit confirmation prompt
    python tools/import_coupons.py --no-commit       # write coupons.json only, don't touch git
"""

import argparse
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from heb_lib.coupons_io import is_partial_scrape, load_existing, summarize_diff, write_success

DEFAULT_INPUT = pathlib.Path.home() / "Downloads" / "heb-coupons-raw.json"


def load_raw(path):
    if not path.exists():
        print(f"Error: {path} not found.", file=sys.stderr)
        print(
            "Run the bookmarklet first (tools/bookmarklet/README.md), or pass "
            "--file to point at wherever it downloaded.",
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


def dedup(coupons):
    seen = set()
    deduped = []
    for c in coupons:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        deduped.append(c)
    return deduped


def run_git(*args):
    subprocess.run(["git", *args], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=pathlib.Path, default=DEFAULT_INPUT)
    parser.add_argument("--yes", action="store_true", help="commit and push without asking")
    parser.add_argument("--no-commit", action="store_true", help="write coupons.json only")
    args = parser.parse_args()

    payload, raw_coupons = load_raw(args.file)
    coupons = dedup(raw_coupons)

    existing = load_existing()

    if is_partial_scrape(len(coupons), existing):
        previous = existing.get("total_coupons") if existing else None
        print(
            f"Refusing to import: {len(coupons)} coupons found"
            + (f", but the previous run had {previous}." if previous else ".")
            + " This looks like a partial scrape rather than a genuinely quiet week.",
            file=sys.stderr,
        )
        print(
            "Re-run the bookmarklet (make sure the page fully loads before clicking it) "
            "and try again.",
            file=sys.stderr,
        )
        sys.exit(1)

    diff = summarize_diff(existing, coupons)
    print(
        f"{len(coupons)} coupons parsed — "
        f"{diff['added']} added, {diff['removed']} removed, "
        f"{diff['changed']} changed, {diff['unchanged']} unchanged."
    )

    source_url = payload.get("source_url", "https://www.heb.com/digital-coupon/coupon-selection/all-coupons")
    output = write_success(coupons, source_url, source="bookmarklet")
    print(
        f"Wrote coupons.json: {len(output['featured_stackable_candidates'])} featured, "
        f"{len(output['general_coupons'])} general."
    )

    if args.no_commit:
        return

    should_commit = args.yes
    if not should_commit:
        answer = input("Commit and push coupons.json now? [y/N] ").strip().lower()
        should_commit = answer == "y"

    if not should_commit:
        print("Left coupons.json updated locally, uncommitted.")
        return

    try:
        run_git("add", "coupons.json")
        result = subprocess.run(["git", "diff", "--cached", "--quiet"])
        if result.returncode == 0:
            print("No changes to commit.")
            return
        run_git("commit", "-m", "Update HEB coupons (bookmarklet import)")
        run_git("push")
        print("Committed and pushed.")
    except subprocess.CalledProcessError as e:
        print(f"git command failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
