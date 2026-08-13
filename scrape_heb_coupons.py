#!/usr/bin/env python3
"""
Scrapes all H-E-B digital coupons and writes coupons.json for heb.html.

Classification logic:
  "Featured / possibly stackable" = basket-threshold coupons, i.e. coupons
  worded like "$X off your basket when you buy $Y of <brand/category>".
  These apply to a whole basket of qualifying items rather than one specific
  product, so they're the ones most likely to be stackable with a
  product-specific coupon on the same order.

  Everything else (single-item cents/dollars off, %-off, Combo Loco
  buy-this-get-that-free, etc.) goes in the general list at the bottom.

Run weekly via GitHub Actions (see .github/workflows/heb-coupons.yml).
"""

import json
import re
import sys
import time
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.heb.com/digital-coupon/coupon-selection/all-coupons"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

# Matches things like "$5 off your basket when you buy $25 of ..."
BASKET_PATTERN = re.compile(
    r"\$\d+(\.\d{2})?\s+off\s+your\s+basket\s+when\s+you\s+buy\s+\$\d+", re.I
)
# Fallback: the little value chip on the card, e.g. "$5 off $25 (select items)"
VALUE_CHIP_BASKET_PATTERN = re.compile(r"\$\d+(\.\d{2})?\s+off\s+\$\d+", re.I)


MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5


def fetch_page(cursor=None, session=None):
    params = {"pageName": "all-coupons"}
    if cursor:
        params["cursor"] = cursor

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(BASE_URL, params=params, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            if len(resp.text) < 2000:
                # Suspiciously short response — likely a block page, captcha,
                # or empty shell that JS would normally fill in.
                raise ValueError(
                    f"Response too short ({len(resp.text)} chars) — possible block/captcha page"
                )
            return resp.text
        except (requests.RequestException, ValueError) as e:
            last_error = e
            print(
                f"  fetch attempt {attempt}/{MAX_RETRIES} failed: {e}",
                file=sys.stderr,
            )
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)

    raise RuntimeError(f"Failed to fetch page after {MAX_RETRIES} attempts: {last_error}")


def parse_coupons(html):
    """Parse one page of coupon cards. Returns list of dicts + next cursor (or None)."""
    soup = BeautifulSoup(html, "html.parser")
    coupons = []

    # Each coupon card sits around an <a> to /digital-coupon/coupon-detail/<id>
    for link in soup.select('a[href*="/digital-coupon/coupon-detail/"]'):
        title = link.get_text(strip=True)
        href = link.get("href", "")
        if not title or not href:
            continue
        m = re.search(r"coupon-detail/(\d+)", href)
        coupon_id = m.group(1) if m else href

        card = link.find_parent()
        # Walk up a couple levels to find the card container with the value/expiry text
        for _ in range(4):
            if card and card.parent:
                card = card.parent
            else:
                break
        card_text = card.get_text(" ", strip=True) if card else ""

        value_match = re.search(
            r"(\$\d+(\.\d{2})?\s+off(\s+\d+)?|\d+%\s+off|\d+¢\s+off(\s+\d+)?|Combo Loco|"
            r"\d+\s+for\s+\$\d+)",
            card_text,
        )
        value = value_match.group(0) if value_match else ""

        expires_match = re.search(r"Expires\s+[\w/]+", card_text)
        expires = expires_match.group(0).replace("Expires ", "") if expires_match else ""

        limit = "Unlimited use"
        if "Limit 1 per customer" in card_text:
            limit = "Limit 1 per customer"

        full_url = "https://www.heb.com" + href if href.startswith("/") else href

        coupons.append(
            {
                "id": coupon_id,
                "value": value,
                "description": title,
                "expires": expires,
                "limit": limit,
                "url": full_url,
            }
        )

    # Dedup within the page (title link + wrapper sometimes both match)
    seen = set()
    deduped = []
    for c in coupons:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        deduped.append(c)

    # Find the "Next" pagination link to get the next cursor
    next_cursor = None
    next_link = soup.find("a", string=re.compile(r"^Next$", re.I))
    if next_link and next_link.get("href"):
        m = re.search(r"cursor=([^&]+)", next_link["href"])
        if m:
            next_cursor = m.group(1)

    return deduped, next_cursor


def is_stackable_candidate(coupon):
    text = coupon["value"] + " " + coupon["description"]
    return bool(BASKET_PATTERN.search(text) or VALUE_CHIP_BASKET_PATTERN.search(text))


class ScrapeFailure(Exception):
    """Raised when the scrape produced nothing usable — triggers fallback in main()."""


def scrape_all(max_pages=25, delay_seconds=1.0):
    session = requests.Session()
    all_coupons = []
    cursor = None
    for page_num in range(1, max_pages + 1):
        html = fetch_page(cursor=cursor, session=session)
        page_coupons, next_cursor = parse_coupons(html)

        if page_num == 1 and not page_coupons:
            # First page parsed to zero coupons — almost always means H-E-B
            # changed their page structure and our selectors no longer match,
            # rather than there genuinely being no coupons.
            raise ScrapeFailure(
                "Parsed 0 coupons from page 1. The site's HTML structure "
                "likely changed — scraper selectors need updating."
            )

        if not page_coupons:
            break
        all_coupons.extend(page_coupons)
        print(f"page {page_num}: {len(page_coupons)} coupons (total {len(all_coupons)})", file=sys.stderr)
        if not next_cursor:
            break
        cursor = next_cursor
        time.sleep(delay_seconds)

    # Dedup across pages
    seen = set()
    deduped = []
    for c in all_coupons:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        deduped.append(c)

    if len(deduped) < 20:
        # A real H-E-B coupon run has hundreds of coupons. A tiny count
        # signals a partial/broken scrape rather than a genuinely quiet week.
        raise ScrapeFailure(
            f"Only found {len(deduped)} coupons total — too few to trust. "
            "Treating as a failed scrape rather than overwriting good data."
        )

    return deduped


def load_existing(path="coupons.json"):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def main():
    try:
        coupons = scrape_all()
    except (ScrapeFailure, RuntimeError) as e:
        print(f"SCRAPE FAILED: {e}", file=sys.stderr)
        existing = load_existing()
        if existing is not None:
            # Leave the last known-good coupons.json in place (don't touch the
            # file), but record that this run failed so the workflow can flag
            # it and stakeholders know the data is stale rather than wrong.
            existing["last_scrape_status"] = "failed"
            existing["last_scrape_error"] = str(e)
            existing["last_scrape_attempted_at"] = datetime.now(timezone.utc).isoformat()
            with open("coupons.json", "w") as f:
                json.dump(existing, f, indent=2)
            print(
                "Kept previous coupons.json unchanged (marked as stale) so the "
                "site doesn't go blank.",
                file=sys.stderr,
            )
        else:
            print("No previous coupons.json to fall back on.", file=sys.stderr)
        sys.exit(1)  # non-zero exit lets the GitHub Action detect and flag the failure

    featured, general = [], []
    for c in coupons:
        (featured if is_stackable_candidate(c) else general).append(c)

    output = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source_url": BASE_URL + "?pageName=all-coupons",
        "total_coupons": len(coupons),
        "last_scrape_status": "success",
        "featured_stackable_candidates": featured,
        "general_coupons": general,
    }

    with open("coupons.json", "w") as f:
        json.dump(output, f, indent=2)

    print(
        f"Wrote coupons.json: {len(featured)} featured, {len(general)} general, "
        f"{len(coupons)} total",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()