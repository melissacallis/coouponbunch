# Bookmarklets (primary data path)

H-E-B's site runs Incapsula bot protection, which blocks plain scraping —
that's why the weekly GitHub Actions scrape (`scrape_coupons.py`) is only
"best effort" and can't be trusted as the only source (see the root
`README.md`). These bookmarklets run **in your own logged-in browser**
instead, so they inherit your real session and reliably get through.

## One-time setup

```
python tools/bookmarklet/build.py
```

This regenerates `tools/bookmarklet/install.html` from the `.src.js` files
in this folder. It's already committed and up to date, so you normally only
need to re-run this after editing a `.src.js` file.

## Weekly refresh (coupons)

1. Open `tools/bookmarklet/install.html` in your browser (double-click the
   file, or visit it on the live site if GitHub Pages is serving this repo).
2. Drag the **📥 Scrape H-E-B Coupons** button to your bookmarks bar. (One-time —
   it stays there.)
3. Go to H-E-B's [All Coupons page](https://www.heb.com/digital-coupon/coupon-selection/all-coupons?pageName=all-coupons),
   logged in.
4. Click the bookmark. A small progress box appears in the corner while it
   walks through every page of coupons.
5. When it finishes, `heb-coupons-raw.json` downloads to your Downloads
   folder automatically.
6. In the repo, run:
   ```
   python tools/import_coupons.py
   ```
   It prints a summary (coupons added/removed/changed) and asks once
   whether to commit and push. Answer `y` and you're done.

If your browser strips `javascript:` bookmarklet links (some do, as a
security measure), `install.html` has a "paste into console instead" option
under each button — open DevTools (F12) → Console → paste → Enter. Same
result.

## Weekly refresh (prices) — optional, once `scrape-prices.src.js` exists

Same pattern, but run the **💲 Scrape H-E-B Prices** bookmark on an H-E-B
product search-results page (with your store selected), then run
`python tools/import_prices.py`. See the root `README.md` for why prices
need a live logged-in session and can't be automated in CI.

## Target refresh (gift card + coupon stacks)

Two bookmarklets, same pattern:

1. **🎯 Scrape Target Gift-Card Products** — run on a Target product-listing
   page filtered to items with a "Buy X / Spend $Y, Get a Target GiftCard"
   promo (like the URL you use to browse those deals), logged in. Downloads
   `target-products-raw.json`. Then run `python tools/import_target_products.py`.
2. **🏷️ Scrape Target Coupons** — run on Target's Circle offers / coupons
   page, logged in. Downloads `target-coupons-raw.json`. Then run
   `python tools/import_target_coupons.py`.

The [Target Deals page](../../target/index.html) only ever shows a product
if it has **both** a gift-card promo (from the first bookmarklet) **and** a
matching brand coupon (from the second) — everything else is filtered out,
so run both before expecting to see results.

Target's DOM structure is unverified from this environment (no network
access to target.com from the sandbox that built this) — if either
bookmarklet finds nothing, inspect a real product/offer card in DevTools and
update the `CANDIDATE_*` selector arrays at the top of the matching
`scrape-target-*.src.js` file, then re-run `python tools/bookmarklet/build.py`.

## Troubleshooting

- **"No coupon cards found"** — make sure the coupon page fully finished
  loading before clicking the bookmark, and that you're on the All Coupons
  page (not a category filter).
- **Import script says the new count looks too low** — it refuses to
  overwrite `coupons.json` if the new scrape looks like a partial run
  (less than half of the previous total). Re-run the bookmarklet — if it
  keeps happening, H-E-B likely changed their page markup and
  `scrape-coupons.src.js`'s `CARD_SELECTOR`/parsing needs updating.
