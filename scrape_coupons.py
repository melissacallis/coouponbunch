#!/usr/bin/env python3
"""Scrapes H-E-B digital coupons and writes coupons.json for index.html.

This is the *opportunistic* scrape path, run weekly via GitHub Actions (see
.github/workflows/heb-coupons.yml). H-E-B runs Incapsula bot protection, so
a headless-browser run from a datacenter IP is not guaranteed to get past
it — this script is a best-effort attempt, not the reliable source of data.

The reliable path is the bookmarklet (tools/bookmarklet/), which runs in the
user's own logged-in browser/session and is documented in
tools/bookmarklet/README.md. Whichever path runs, coupons.json is only ever
overwritten by a run that looks complete (see heb_lib.coupons_io) — a
blocked or partial run leaves the last known-good data in place and marks
the file stale instead of blanking the site out.

Classification logic:
  "Featured / possibly stackable" = basket-threshold coupons, i.e. coupons
  worded like "$X off your basket when you buy $Y of <brand/category>".
  These apply to a whole basket of qualifying items rather than one specific
  product, so they're the ones most likely to be stackable with a
  product-specific coupon on the same order.

  Everything else (single-item cents/dollars off, %-off, Combo Loco
  buy-this-get-that-free, etc.) goes in the general list at the bottom.
"""

import json
import re
import sys
from datetime import datetime, timezone

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from heb_lib.classify import is_stackable_candidate
from heb_lib.coupons_io import is_partial_scrape, load_existing, write_failure, write_success

BASE_URL = "https://www.heb.com/digital-coupon/coupon-selection/all-coupons?pageName=all-coupons"
HOME_URL = "https://www.heb.com/"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
VIEWPORT = {"width": 1366, "height": 900}

MAX_PAGES = 30  # "Next" clicks or scroll rounds, whichever pagination style is present
NAV_TIMEOUT_MS = 30_000
CARD_WAIT_TIMEOUT_MS = 20_000

CARD_SELECTOR = 'a[href*="/digital-coupon/coupon-detail/"]'

INCAPSULA_MARKERS = ("_Incapsula_Resource", "Request unsuccessful", "Incapsula incident")


class ScrapeFailure(Exception):
    """Raised when the scrape produced nothing usable — triggers the
    keep-last-good-data fallback in main()."""


def log(msg):
    print(msg, file=sys.stderr)


def detect_block_page(html):
    return any(marker in html for marker in INCAPSULA_MARKERS)


VALUE_PATTERNS = [
    re.compile(r"\$\d+(?:\.\d{2})?\s+off(\s+\d+)?", re.I),
    re.compile(r"\d+%\s+off", re.I),
    re.compile(r"\d+¢\s+off(\s+\d+)?", re.I),
    re.compile(r"\d+\s+for\s+\$\d+", re.I),
    re.compile(r"Combo Loco", re.I),
]
SAVE_DOLLAR_RE = re.compile(r"Save\s+\$(\d+(?:\.\d{2})?)", re.I)
BASKET_SENTENCE_RE = re.compile(
    r"\$(\d+(?:\.\d{2})?)\s+off\s+your\s+basket\s+when\s+you\s+buy\s+\$(\d+(?:\.\d{2})?)", re.I
)


def extract_value(title, card_text):
    """Basket coupons get a clean short chip like "$5 off $25" built from
    the two amounts, rather than the whole matched sentence.

    For everything else, real dollar/percent/cents/"N for $" value patterns
    are checked BEFORE "Combo Loco" specifically, and the coupon's own title
    text is checked before the wider card container — walking up parent
    elements to find a card's boundaries is inherently approximate, and can
    sweep in a neighboring card's "Combo Loco" badge; letting a specific
    dollar/percent match win avoids that coupon being mislabeled just
    because stray badge text happened to appear in the scanned region.
    """
    m = BASKET_SENTENCE_RE.search(title)
    if m:
        return f"${m.group(1)} off ${m.group(2)}"

    # "Save $2.00 on ONE Dove..." is a common alternate phrasing for a flat
    # dollar-off coupon — normalize it to "$2.00 off" so it still matches
    # the "$X off" pattern the savings-calculator logic looks for.
    m = SAVE_DOLLAR_RE.search(title)
    if m:
        return f"${m.group(1)} off"

    for source in (title, card_text):
        for pattern in VALUE_PATTERNS:
            found = pattern.search(source)
            if found:
                return found.group(0)
    return ""


def parse_coupons(html):
    """Parse one rendered page's worth of coupon cards. Same field
    extraction the previous requests-based scraper used — H-E-B's card
    markup, once rendered, is plain HTML we can walk with BeautifulSoup."""
    soup = BeautifulSoup(html, "html.parser")
    coupons = []

    for link in soup.select(CARD_SELECTOR):
        title = link.get_text(strip=True)
        href = link.get("href", "")
        if not title or not href:
            continue
        m = re.search(r"coupon-detail/(\d+)", href)
        coupon_id = m.group(1) if m else href

        card = link.find_parent()
        for _ in range(4):
            if card and card.parent:
                card = card.parent
            else:
                break
        card_text = card.get_text(" ", strip=True) if card else ""
        value = extract_value(title, card_text)

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

    seen = set()
    deduped = []
    for c in coupons:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        deduped.append(c)
    return deduped


def find_next_control(page):
    """Look for a 'Next' pagination link/button. Returns a Locator or None."""
    candidates = [
        page.get_by_role("link", name=re.compile(r"^next$", re.I)),
        page.get_by_role("button", name=re.compile(r"^next$", re.I)),
        page.locator('a:has-text("Next")'),
        page.locator('button:has-text("Next")'),
    ]
    for loc in candidates:
        try:
            if loc.count() > 0 and loc.first.is_visible():
                return loc.first
        except Exception:
            continue
    return None


def scroll_and_wait_for_growth(page, previous_count, rounds=3):
    """Infinite-scroll fallback: scroll to bottom and see if more cards
    appear. Returns the new card count."""
    for _ in range(rounds):
        page.mouse.wheel(0, 4000)
        page.wait_for_timeout(1200)
        count = page.locator(CARD_SELECTOR).count()
        if count > previous_count:
            return count
    return page.locator(CARD_SELECTOR).count()


def scrape_all(headless=True):
    all_coupons = []
    api_hits = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(user_agent=USER_AGENT, viewport=VIEWPORT)
        page = context.new_page()
        page.set_default_timeout(NAV_TIMEOUT_MS)

        # Log any JSON responses touching the coupon endpoints — if H-E-B's
        # picker is backed by a clean internal API, this is how a future
        # run would discover it instead of guessing at DOM/pagination
        # mechanics. Doesn't change parsing behavior today.
        def on_response(response):
            try:
                ctype = response.headers.get("content-type", "")
                if "coupon" in response.url.lower() and "json" in ctype:
                    api_hits.append({"url": response.url, "status": response.status})
            except Exception:
                pass

        page.on("response", on_response)

        try:
            page.goto(HOME_URL, wait_until="domcontentloaded")
        except Exception as e:
            log(f"Warm-up navigation to homepage failed (continuing anyway): {e}")

        try:
            page.goto(BASE_URL, wait_until="domcontentloaded")
        except Exception as e:
            browser.close()
            raise ScrapeFailure(f"Failed to load coupon page: {e}")

        html = page.content()
        if detect_block_page(html):
            browser.close()
            raise ScrapeFailure(
                "Detected an Incapsula challenge/block page instead of coupon content. "
                "The opportunistic Actions scrape got flagged this run — use the "
                "bookmarklet (tools/bookmarklet/) to refresh coupons.json instead."
            )

        try:
            page.wait_for_selector(CARD_SELECTOR, timeout=CARD_WAIT_TIMEOUT_MS)
        except Exception:
            browser.close()
            raise ScrapeFailure(
                "No coupon cards rendered within the timeout. Either the page "
                "structure changed and CARD_SELECTOR needs updating, or the page "
                "was blocked/empty."
            )

        for page_num in range(1, MAX_PAGES + 1):
            html = page.content()
            page_coupons = parse_coupons(html)

            if page_num == 1 and not page_coupons:
                browser.close()
                raise ScrapeFailure(
                    "Parsed 0 coupons from the rendered page. H-E-B's markup "
                    "likely changed — CARD_SELECTOR/parse_coupons need updating."
                )

            all_coupons.extend(page_coupons)
            log(f"page {page_num}: {len(page_coupons)} cards parsed (running total {len(all_coupons)})")

            next_control = find_next_control(page)
            if next_control is not None:
                try:
                    next_control.click()
                    page.wait_for_timeout(1500)
                    page.wait_for_selector(CARD_SELECTOR, timeout=CARD_WAIT_TIMEOUT_MS)
                    continue
                except Exception as e:
                    log(f"'Next' control found but click/wait failed, stopping pagination: {e}")
                    break

            # No Next control — try infinite-scroll pagination instead.
            current_card_count = page.locator(CARD_SELECTOR).count()
            grown_count = scroll_and_wait_for_growth(page, current_card_count)
            if grown_count <= current_card_count:
                log("No 'Next' control and scrolling produced no new cards — assuming end of list.")
                break

        browser.close()

    if api_hits:
        log(f"Observed {len(api_hits)} JSON responses touching coupon endpoints during the run:")
        for hit in api_hits[:10]:
            log(f"  {hit['status']} {hit['url']}")
        log(
            "If these look like a clean coupon-data API, consider replacing "
            "DOM parsing with a direct call to that endpoint."
        )

    # Dedup across pages
    seen = set()
    deduped = []
    for c in all_coupons:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        deduped.append(c)

    return deduped


def main():
    existing = load_existing()

    try:
        coupons = scrape_all()
    except ScrapeFailure as e:
        log(f"SCRAPE FAILED: {e}")
        if existing is not None:
            write_failure(existing, e)
            log("Kept previous coupons.json unchanged (marked as stale) so the site doesn't go blank.")
        else:
            log("No previous coupons.json to fall back on.")
        sys.exit(1)

    if is_partial_scrape(len(coupons), existing):
        msg = (
            f"Only found {len(coupons)} coupons"
            + (f" (previous run had {existing.get('total_coupons')})" if existing else "")
            + " — treating as a partial/blocked scrape rather than overwriting good data."
        )
        log(f"SCRAPE FAILED: {msg}")
        if existing is not None:
            write_failure(existing, msg)
            log("Kept previous coupons.json unchanged (marked as stale).")
        sys.exit(1)

    output = write_success(coupons, BASE_URL, source="github-actions-playwright")
    log(
        f"Wrote coupons.json: {len(output['featured_stackable_candidates'])} featured, "
        f"{len(output['general_coupons'])} general, {len(coupons)} total"
    )


if __name__ == "__main__":
    main()
