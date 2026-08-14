# CouponBunch

Finds stackable H-E-B coupon combos — pair a "$X off your basket when you
buy $Y of &lt;brand&gt;" coupon with matching manufacturer coupons and see
the real dollar savings, live, as you check items off.

**[Open the site](index.html)** (served via GitHub Pages from this repo's
`main` branch).

## How it works

- `coupons.json` holds the current coupon list, split into **featured**
  (basket-threshold) and **general** (everything else) coupons.
- `prices.json` holds scraped product prices, used to compute exact
  dollar savings. It's fine for this to be empty/partial — the site falls
  back to letting you type a price in by hand, which it remembers for next
  time (saved in your browser's `localStorage`).
- `index.html` + `assets/app.js` render the site: a hero savings number,
  a search/filter list, and a "Stack Builder" — click a featured coupon to
  see which general coupons plausibly combine with it, grouped by
  confidence (**strong match** vs **possible — verify at checkout**), with
  a running subtotal/savings/final-price total.

## Keeping the data fresh

H-E-B's site runs Incapsula bot protection, which blocks plain scraping.
Two paths keep `coupons.json`/`prices.json` up to date:

1. **Bookmarklets (primary, reliable)** — run in your own logged-in
   browser, so they inherit your real session and get through. This is
   also the only realistic way to capture prices, since those need a
   store-selected session. See **[`tools/bookmarklet/README.md`](tools/bookmarklet/README.md)**
   for setup — it's a one-time drag-to-bookmarks-bar step, then one click +
   one command per refresh.
2. **GitHub Actions (opportunistic)** — `.github/workflows/heb-coupons.yml`
   runs `scrape_coupons.py` (headless Playwright) weekly. It may get
   blocked by Incapsula from GitHub's datacenter IPs; when it does, it
   leaves the last known-good `coupons.json` in place (marked stale) rather
   than blanking the site, and opens a GitHub issue pointing at the
   bookmarklet as the fix.

Either path refuses to overwrite good data with a suspiciously small
result (less than half the previous coupon count) — see
`heb_lib/coupons_io.py`.

## Repo layout

```
index.html                    the site (static, no build step)
assets/app.js, style.css      stacking/confidence engine + rendering
coupons.json, prices.json     current data
scrape_coupons.py             opportunistic weekly scraper (GitHub Actions)
heb_lib/                      shared classification + load/save logic
tools/import_coupons.py       imports a bookmarklet coupon export
tools/import_prices.py        imports a bookmarklet price export
tools/bookmarklet/            bookmarklet sources, build script, usage docs
sample_data/                  fixtures for testing the UI without network access
.github/workflows/            weekly scrape automation
```

## Local development

No build step. To preview against sample data without touching real
coupons/prices:

```
cp sample_data/coupons.sample.json coupons.json
cp sample_data/prices.sample.json prices.json
python -m http.server 8000
# open http://localhost:8000
```

(Don't commit those copies over the real data — `git checkout coupons.json
prices.json` afterward, or just work in a scratch copy of the repo.)

## Setup checklist for a new fork

1. Enable GitHub Pages on this repo (Settings → Pages → serve from `main`
   branch root).
2. Run `python tools/bookmarklet/build.py` once to generate
   `tools/bookmarklet/install.html`, then follow
   `tools/bookmarklet/README.md` to do your first coupon (and optionally
   price) import.
3. The weekly GitHub Action needs no secrets — it only needs `contents:
   write` and `issues: write` permissions (already set in the workflow),
   which are on by default for a repo's own `GITHUB_TOKEN`.
