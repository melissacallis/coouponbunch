/**
 * CouponBunch Target coupons/Circle-offers scraping bookmarklet — source
 * (readable) version.
 *
 * Run this on Target's Circle offers / coupons page (e.g.
 * target.com/circle/offers), while logged in. Selectors are a best guess —
 * this sandbox has no network access to target.com to verify real markup
 * against. If it finds zero coupons, inspect an offer card in DevTools and
 * update the CANDIDATE_* selectors below, then re-run
 * `python tools/bookmarklet/build.py`.
 *
 * Usage: click the bookmark, it captures the current page's offers and
 * downloads "target-coupons-raw.json". Then run:
 *   python tools/import_target_coupons.py
 */
(() => {
  const CANDIDATE_CARD_SELECTORS = [
    '[data-test="offer-card"]',
    '[data-test*="OfferCard"]',
    '[class*="OfferCard"]',
    '[class*="offer-card"]',
    'li[class*="offer"]',
  ];
  const CANDIDATE_BRAND_SELECTORS = [
    '[data-test*="brand"]', '[class*="Brand"]', '[class*="brand"]', 'h3', 'h4',
  ];
  const CANDIDATE_DESC_SELECTORS = [
    '[data-test*="description"]', '[data-test*="title"]', '[class*="Description"]', 'p',
  ];

  function makeOverlay() {
    const el = document.createElement('div');
    el.id = 'coupon-bunch-target-coupons-overlay';
    el.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:999999',
      'background:#1b1b1b', 'color:#fff', 'font:13px/1.4 -apple-system,sans-serif',
      'padding:12px 16px', 'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      'max-width:280px',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function firstMatching(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const els = root.querySelectorAll(sel);
        if (els.length > 0) return Array.from(els);
      } catch (e) {
        // invalid selector for this browser — skip
      }
    }
    return [];
  }

  function extractValue(text) {
    let m = (text || '').match(/\$\d+(?:\.\d{2})?\s+off/i);
    if (m) return m[0];
    m = (text || '').match(/\d+%\s+off/i);
    return m ? m[0] : '';
  }

  function scrapeCards() {
    const cards = firstMatching(CANDIDATE_CARD_SELECTORS);
    const coupons = [];

    for (const card of cards) {
      const brandEl = firstMatching(CANDIDATE_BRAND_SELECTORS, card)[0];
      const descEl = firstMatching(CANDIDATE_DESC_SELECTORS, card)[0];
      const cardText = card.textContent.replace(/\s+/g, ' ').trim();
      const linkEl = card.querySelector('a');

      const brand = brandEl ? brandEl.textContent.trim() : '';
      const description = descEl ? descEl.textContent.trim() : cardText.slice(0, 100);
      const value = extractValue(cardText);
      if (!brand || !description) continue;

      coupons.push({
        id: `${brand}-${description}`.replace(/\s+/g, '-').toLowerCase().slice(0, 60),
        brand,
        description,
        value,
        url: linkEl ? new URL(linkEl.getAttribute('href'), location.origin).href : location.href,
      });
    }
    return coupons;
  }

  // --- main ---
  if (!location.hostname.endsWith('target.com')) {
    const overlay = makeOverlay();
    overlay.textContent = '⚠️ Run this on a target.com offers/coupons page, not here.';
    return;
  }

  const coupons = scrapeCards();
  const overlay = makeOverlay();

  if (coupons.length === 0) {
    overlay.innerHTML =
      '⚠️ No offers found on this page. The CSS selectors in ' +
      'scrape-target-coupons.src.js likely need updating for Target\'s current ' +
      'markup — inspect an offer card and edit CANDIDATE_CARD_SELECTORS / ' +
      'CANDIDATE_BRAND_SELECTORS / CANDIDATE_DESC_SELECTORS.';
    console.warn('[CouponBunch] 0 offers found. Selectors may need updating.');
    return;
  }

  const payload = {
    scraped_at: new Date().toISOString(),
    source: 'bookmarklet',
    source_url: location.href,
    coupons,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'target-coupons-raw.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  overlay.innerHTML = `✅ ${coupons.length} offer(s) saved to target-coupons-raw.json.<br><br>Now run: python tools/import_target_coupons.py`;
  setTimeout(() => overlay.remove(), 15000);
})();
