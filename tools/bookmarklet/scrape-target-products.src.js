/**
 * CouponBunch Target product-scraping bookmarklet — source (readable) version.
 *
 * Run this on a Target product-listing page (e.g. a category filtered to
 * gift-card promo items, like target.com/pl/.../?facetedValue=...), while
 * logged in. Selectors are a best guess — this sandbox has no network access
 * to target.com to verify real markup against. If it finds zero products,
 * inspect a product card in DevTools and update the CANDIDATE_* selectors
 * below, then re-run `python tools/bookmarklet/build.py`.
 *
 * It only keeps products that actually show a "Buy X / Spend $Y, Get a
 * Target GiftCard" badge — that's the whole point of this page, so products
 * without one are silently skipped rather than cluttering the export.
 *
 * Usage: click the bookmark, it captures the current page's gift-card
 * products and downloads "target-products-raw.json". Then run:
 *   python tools/import_target_products.py
 */
(() => {
  const CANDIDATE_CARD_SELECTORS = [
    '[data-test="product-card"]',
    '[data-test*="ProductCard"]',
    '[class*="ProductCardWrapper"]',
    '[class*="styles_cardWrapper"]',
    'li[class*="product"]',
  ];
  const CANDIDATE_NAME_SELECTORS = [
    '[data-test="product-title"]', '[data-test*="title"]', 'a[href*="/p/"]',
  ];
  const CANDIDATE_PRICE_SELECTORS = [
    '[data-test="product-price"]', '[data-test*="price"]', '[class*="Price"]',
  ];
  const CANDIDATE_PROMO_SELECTORS = [
    '[data-test*="giftcard"]', '[data-test*="GiftCard"]',
    '[class*="GiftCard"]', '[class*="giftcard"]', '[class*="Promotion"]',
  ];
  const CANDIDATE_IMAGE_SELECTORS = ['img'];

  function makeOverlay() {
    const el = document.createElement('div');
    el.id = 'coupon-bunch-target-overlay';
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

  function extractPrice(text) {
    const m = (text || '').match(/\$(\d+(?:\.\d{2})?)/);
    return m ? parseFloat(m[1]) : null;
  }

  function extractId(card) {
    const link = card.querySelector('a[href*="/p/"]') || card.querySelector('a[href*="/A-"]');
    if (!link) return null;
    const m = (link.getAttribute('href') || '').match(/A-(\d+)/);
    return m ? `A-${m[1]}` : null;
  }

  function guessBrand(name) {
    // First word/phrase of the product name is usually the brand on Target's
    // listings (e.g. "Tide Liquid Laundry Detergent..." -> "Tide"). Not
    // perfect, but a reasonable default — edit per-product in the JSON if wrong.
    if (!name) return '';
    return name.split(/\s+/).slice(0, 1).join(' ');
  }

  function scrapeCards() {
    const cards = firstMatching(CANDIDATE_CARD_SELECTORS);
    const products = [];

    for (const card of cards) {
      const promoEl = firstMatching(CANDIDATE_PROMO_SELECTORS, card)[0];
      const promoText = promoEl ? promoEl.textContent.trim() : '';
      if (!/target\s*gift\s*card/i.test(promoText)) continue; // only keep gift-card products

      const nameEl = firstMatching(CANDIDATE_NAME_SELECTORS, card)[0];
      const priceEl = firstMatching(CANDIDATE_PRICE_SELECTORS, card)[0];
      const imgEl = firstMatching(CANDIDATE_IMAGE_SELECTORS, card)[0];
      const linkEl = card.querySelector('a[href*="/p/"]');

      const name = nameEl ? nameEl.textContent.trim() : '';
      const price = priceEl ? extractPrice(priceEl.textContent) : null;
      if (!name || price == null) continue;

      products.push({
        id: extractId(card) || `${name}-${price}`,
        name,
        brand: guessBrand(name),
        price,
        image: imgEl ? imgEl.src : null,
        gift_card_promo: promoText,
        url: linkEl ? new URL(linkEl.getAttribute('href'), location.origin).href : location.href,
      });
    }
    return products;
  }

  // --- main ---
  if (!location.hostname.endsWith('target.com')) {
    const overlay = makeOverlay();
    overlay.textContent = '⚠️ Run this on a target.com product-listing page, not here.';
    return;
  }

  const products = scrapeCards();
  const overlay = makeOverlay();

  if (products.length === 0) {
    overlay.innerHTML =
      '⚠️ No gift-card products found on this page. Either none of the visible ' +
      'products have a gift-card badge, or the CSS selectors in ' +
      'scrape-target-products.src.js need updating for Target\'s current markup ' +
      '— inspect a product card and edit CANDIDATE_CARD_SELECTORS / ' +
      'CANDIDATE_PROMO_SELECTORS.';
    console.warn('[CouponBunch] 0 gift-card products found. Selectors may need updating.');
    return;
  }

  const payload = {
    scraped_at: new Date().toISOString(),
    source: 'bookmarklet',
    source_url: location.href,
    products,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'target-products-raw.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  overlay.innerHTML = `✅ ${products.length} gift-card product(s) saved to target-products-raw.json.<br><br>Now run: python tools/import_target_products.py`;
  setTimeout(() => overlay.remove(), 15000);
})();
