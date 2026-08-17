#!/usr/bin/env python3
"""Regenerates tools/bookmarklet/install.html from the .src.js source files.

Run this by hand whenever a *.src.js bookmarklet source changes:
    python tools/bookmarklet/build.py

Why a generated HTML page and not just a link in README.md: GitHub
sanitizes markdown it renders on github.com and strips javascript: URLs, so
a bookmarklet link pasted straight into README.md wouldn't be draggable
there. A plain HTML page (served by GitHub Pages alongside the rest of the
site, or just opened locally as a file) isn't sanitized, so the drag-to-
bookmarks-bar link actually works.
"""

import html
import pathlib
import urllib.parse

HERE = pathlib.Path(__file__).parent

BOOKMARKLETS = [
    {
        "id": "coupons",
        "title": "📥 Scrape H-E-B Coupons",
        "src_file": "scrape-coupons.src.js",
        "run_on": "H-E-B's All Coupons page (heb.com/digital-coupon/coupon-selection/all-coupons), while logged in",
        "then": "python tools/import_coupons.py",
    },
    {
        "id": "prices",
        "title": "💲 Scrape H-E-B Prices",
        "src_file": "scrape-prices.src.js",
        "run_on": "an H-E-B product search-results page, while logged in with your store selected",
        "then": "python tools/import_prices.py",
    },
    {
        "id": "target-products",
        "title": "🎯 Scrape Target Gift-Card Products",
        "src_file": "scrape-target-products.src.js",
        "run_on": "a Target product-listing page filtered to gift-card promos, while logged in",
        "then": "python tools/import_target_products.py",
    },
    {
        "id": "target-coupons",
        "title": "🏷️ Scrape Target Coupons",
        "src_file": "scrape-target-coupons.src.js",
        "run_on": "Target's Circle offers / coupons page, while logged in",
        "then": "python tools/import_target_coupons.py",
    },
    {
        "id": "walgreens-weeklyad",
        "title": "📰 Scrape Walgreens Weekly Ad",
        "src_file": "scrape-walgreens-weeklyad.src.js",
        "run_on": "Walgreens' Weekly Ad page, while logged in with your store selected",
        "then": "python tools/import_walgreens_weeklyad.py",
    },
    {
        "id": "walgreens-coupons",
        "title": "🏷️ Scrape Walgreens Coupons",
        "src_file": "scrape-walgreens-coupons.src.js",
        "run_on": "Walgreens' coupons page (walgreens.com/offers/offers.jsp?ban=dl_dlsp_MegaMenu_Coupons), while logged in",
        "then": "python tools/import_walgreens_coupons.py",
    },
    {
        "id": "walgreens-cashrewards",
        "title": "💵 Scrape Walgreens Cash Rewards",
        "src_file": "scrape-walgreens-cashrewards.src.js",
        "run_on": "Walgreens' Cash rewards / myWalgreens offers page, while logged in",
        "then": "python tools/import_walgreens_cashrewards.py",
    },
]

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CouponBunch — Install Bookmarklets</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
         max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1b1b1b; line-height: 1.5; }}
  h1 {{ font-size: 1.4rem; }}
  .bookmarklet-card {{ border: 1px solid #e3e1db; border-radius: 12px; padding: 20px; margin: 20px 0; }}
  .bookmarklet-card p.run-on {{ color: #6b6b6b; font-size: 0.9rem; }}
  .drag-link {{ display: inline-block; background: #d5121e; color: white; text-decoration: none;
                padding: 10px 18px; border-radius: 8px; font-weight: 600; cursor: grab; }}
  .steps {{ font-size: 0.92rem; }}
  code {{ background: #f7f6f3; padding: 1px 6px; border-radius: 4px; }}
  details summary {{ cursor: pointer; color: #6b6b6b; font-size: 0.85rem; margin-top: 10px; }}
  pre {{ background: #1b1b1b; color: #d4d4d4; padding: 14px; border-radius: 8px; overflow-x: auto; font-size: 0.78rem; }}
</style>
</head>
<body>
<h1>CouponBunch bookmarklets</h1>
<p>Drag a button below to your bookmarks bar. Click it while on the matching page —
it runs in your own logged-in browser, so it sees exactly what you see.</p>

{cards}

<p style="color:#6b6b6b; font-size:0.85rem; margin-top:32px;">
  Regenerate this page with <code>python tools/bookmarklet/build.py</code> after editing
  a <code>.src.js</code> file.
</p>
</body>
</html>
"""

CARD_TEMPLATE = """<div class="bookmarklet-card">
  <h2>{title}</h2>
  <p class="run-on">Run on: {run_on}</p>
  <p><a class="drag-link" href="{href}">{title}</a> ← drag this to your bookmarks bar</p>
  <ol class="steps">
    <li>Go to the page above, logged in.</li>
    <li>Click the bookmark. Watch the on-page progress box.</li>
    <li>A file downloads automatically to your Downloads folder.</li>
    <li>Run <code>{then}</code> and follow the prompt.</li>
  </ol>
  <details>
    <summary>Bookmark won't drag, or your browser strips javascript: links? Use the console instead.</summary>
    <p>Open DevTools (F12) on the page above, go to the Console tab, paste the script below, and press Enter.</p>
    <pre><code>{escaped_source}</code></pre>
  </details>
</div>
"""


def build_bookmarklet_href(src_path: pathlib.Path) -> str:
    source = src_path.read_text()
    return "javascript:" + urllib.parse.quote(source)


def main():
    cards = []
    for bm in BOOKMARKLETS:
        src_path = HERE / bm["src_file"]
        if not src_path.exists():
            print(f"skipping {bm['id']}: {bm['src_file']} not found yet")
            continue
        href = build_bookmarklet_href(src_path)
        escaped_source = html.escape(src_path.read_text())
        cards.append(
            CARD_TEMPLATE.format(
                title=bm["title"],
                run_on=bm["run_on"],
                href=href,
                then=bm["then"],
                escaped_source=escaped_source,
            )
        )

    if not cards:
        print("No bookmarklet sources found — nothing to build.")
        return

    output = PAGE_TEMPLATE.format(cards="\n".join(cards))
    out_path = HERE / "install.html"
    out_path.write_text(output)
    print(f"Wrote {out_path} ({len(cards)} bookmarklet(s)).")


if __name__ == "__main__":
    main()
