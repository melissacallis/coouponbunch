/**
 * CouponBunch price-scraping bookmarklet — source (readable) version.
 *
 * Unlike the coupon scraper, this one's DOM selectors are a best guess —
 * this sandbox has no network access to heb.com to verify real product-card
 * markup against. If it finds zero products, open DevTools, inspect one
 * product card on a real H-E-B search-results page, and add its
 * container/name/price selectors to the CANDIDATE_* arrays below. Then
 * re-run `python tools/bookmarklet/build.py`.
 *
 * Usage: search for a brand/product on heb.com (logged in, store selected),
 * click this bookmark — it captures whatever product cards are visible and
 * adds them to a running batch (kept in sessionStorage, so you can repeat
 * this for several brands before downloading once). An on-page overlay
 * shows the running count and has "Download all" / "Clear" buttons.
 */
(() => {
  const CAPTURE_KEY = 'coupon-bunch-price-capture';

  // Best-guess selectors for a product-card container on an H-E-B search
  // results page. Tried in order; the first one that matches multiple
  // elements is used. EDIT THIS if it finds 0 products — inspect a real
  // product card and add its selector here.
  const CANDIDATE_CARD_SELECTORS = [
    '[data-testid*="product-card"]',
    '[data-qa*="product"]',
    '[class*="ProductCard"]',
    '[class*="product-card"]',
    'li[class*="product"]',
    'article[class*="product"]',
  ];

  // Within a card, best-guess selectors for the name and price text. Falls
  // back to regex-scanning the card's full text if none of these match.
  const CANDIDATE_NAME_SELECTORS = [
    '[data-testid*="product-name"]', '[data-testid*="title"]',
    '[class*="ProductName"]', '[class*="product-name"]', '[class*="title"]', 'h3', 'h2',
  ];
  const CANDIDATE_PRICE_SELECTORS = [
    '[data-testid*="price"]', '[class*="Price"]', '[class*="price"]',
  ];

  const CANDIDATE_STORE_SELECTORS = [
    '[data-testid*="store-name"]', '[data-testid*="selected-store"]', '[class*="StoreName"]',
  ];

  function makeOverlay() {
    const el = document.createElement('div');
    el.id = 'coupon-bunch-price-overlay';
    el.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:999999',
      'background:#1b1b1b', 'color:#fff', 'font:13px/1.4 -apple-system,sans-serif',
      'padding:12px 16px', 'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      'max-width:280px',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function loadBatch() {
    try {
      return JSON.parse(sessionStorage.getItem(CAPTURE_KEY) || '{"batches":[]}');
    } catch (e) {
      return { batches: [] };
    }
  }

  function saveBatch(data) {
    sessionStorage.setItem(CAPTURE_KEY, JSON.stringify(data));
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
    const m = text.match(/\$(\d+(?:\.\d{2})?)/);
    return m ? parseFloat(m[1]) : null;
  }

  function guessSearchTerm() {
    const input = document.querySelector('input[type="search"], input[name*="search" i], input[placeholder*="search" i]');
    if (input && input.value) return input.value.trim();
    const url = new URL(location.href);
    for (const key of ['q', 'query', 'search', 'searchTerm']) {
      if (url.searchParams.get(key)) return url.searchParams.get(key);
    }
    return null;
  }

  function guessStoreId() {
    const els = firstMatching(CANDIDATE_STORE_SELECTORS);
    if (els.length) return els[0].textContent.trim();
    return null;
  }

  function scrapeCards() {
    const cards = firstMatching(CANDIDATE_CARD_SELECTORS);
    const products = [];

    for (const card of cards) {
      const nameEl = firstMatching(CANDIDATE_NAME_SELECTORS, card)[0];
      const priceEl = firstMatching(CANDIDATE_PRICE_SELECTORS, card)[0];
      const cardText = card.textContent.replace(/\s+/g, ' ').trim();

      const name = nameEl ? nameEl.textContent.trim() : cardText.slice(0, 80);
      const price = priceEl ? extractPrice(priceEl.textContent) : extractPrice(cardText);

      if (name && price != null) {
        products.push({ name, price });
      }
    }
    return products;
  }

  function render(overlay, batchData) {
    const totalProducts = batchData.batches.reduce((s, b) => s + b.products.length, 0);
    overlay.innerHTML = `
      <div style="margin-bottom:8px;">💲 <strong>${totalProducts}</strong> product${totalProducts === 1 ? '' : 's'} captured across ${batchData.batches.length} search${batchData.batches.length === 1 ? '' : 'es'}.</div>
      <div style="font-size:11px; opacity:.75; margin-bottom:8px;">Search another brand and click this bookmark again, or download now.</div>
      <button id="cb-price-download" style="background:#d5121e;color:#fff;border:0;padding:6px 12px;border-radius:6px;font-weight:600;cursor:pointer;margin-right:6px;">Download all</button>
      <button id="cb-price-clear" style="background:transparent;color:#fff;border:1px solid #555;padding:6px 10px;border-radius:6px;cursor:pointer;">Clear</button>
    `;
    overlay.querySelector('#cb-price-download').onclick = () => downloadAll(batchData);
    overlay.querySelector('#cb-price-clear').onclick = () => {
      sessionStorage.removeItem(CAPTURE_KEY);
      overlay.remove();
    };
  }

  function downloadJSON(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadAll(batchData) {
    const payload = {
      scraped_at: new Date().toISOString(),
      source: 'bookmarklet',
      store_id: guessStoreId(),
      batches: batchData.batches,
    };
    downloadJSON('heb-prices-raw.json', payload);
  }

  // --- main ---
  if (!location.hostname.endsWith('heb.com')) {
    const overlay = makeOverlay();
    overlay.textContent = '⚠️ Run this on a heb.com search-results page, not here.';
    return;
  }

  const products = scrapeCards();
  const overlay = document.getElementById('coupon-bunch-price-overlay') || makeOverlay();

  if (products.length === 0) {
    overlay.innerHTML =
      '⚠️ No products found on this page. The CSS selectors in scrape-prices.src.js ' +
      'likely need updating for H-E-B\'s current markup — inspect a product card and ' +
      'edit CANDIDATE_CARD_SELECTORS / CANDIDATE_NAME_SELECTORS / CANDIDATE_PRICE_SELECTORS.';
    console.warn('[CouponBunch] 0 products found. Selectors need updating — see scrape-prices.src.js.');
    return;
  }

  const searchTerm = guessSearchTerm() || prompt('Which brand/search term is this batch for?', '') || 'unknown';
  const batchData = loadBatch();
  batchData.batches.push({ search_term: searchTerm, products });
  saveBatch(batchData);

  render(overlay, batchData);
})();
