/**
 * CouponBunch Walgreens Weekly Ad scraping bookmarklet — source (readable)
 * version.
 *
 * UNVERIFIED: this project has no network access to walgreens.com, so
 * unlike some of the Target selectors, none of the CANDIDATE_* selectors
 * below have been checked against real markup. If it finds zero items,
 * inspect a product tile on the Weekly Ad page in DevTools and update the
 * CANDIDATE_* selector arrays, then re-run `python tools/bookmarklet/build.py`.
 *
 * Run this on Walgreens' Weekly Ad page (walgreens.com/weeklyad or similar),
 * while logged in with your store selected.
 *
 * Usage: click the bookmark — it captures the current page's sale items and
 * opens a new tab with the JSON already selected in a text box (no DevTools
 * needed). Press Ctrl+C there, then run:
 *   python tools/import_walgreens_weeklyad.py --file wherever-you-saved-it.json
 * or paste it straight to Claude in chat.
 */
(async () => {
  const NO_GROWTH_ROUNDS_BEFORE_GIVING_UP = 4;
  const MAX_ROUNDS = 60;
  const WAIT_AFTER_ACTION_MS = 1500;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
    ]);
  }

  function openCopyTab(title, text) {
    const win = window.open('', '_blank');
    if (!win) return false; // popup blocked
    win.document.title = title;
    win.document.body.style.cssText =
      'font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:20px;' +
      'background:#1b1b1b;color:#fff;box-sizing:border-box;';
    win.document.body.innerHTML =
      '<p style="font-size:15px;margin:0 0 12px;">✅ Done — this text is already selected. ' +
      'Press <b>Ctrl+C</b> (or <b>Cmd+C</b> on Mac) to copy it, then paste it wherever you need it.</p>' +
      '<textarea id="cb-out" readonly style="width:100%;height:75vh;font:12px/1.4 monospace;' +
      'padding:10px;box-sizing:border-box;background:#111;color:#0f0;border:1px solid #444;"></textarea>';
    const ta = win.document.getElementById('cb-out');
    ta.value = text;
    ta.focus();
    ta.select();
    return true;
  }

  // Pure guesses — Walgreens' real markup has never been inspected for this
  // project. Common patterns across modern React storefronts are listed
  // first, with looser class-name fallbacks after.
  const CANDIDATE_CARD_SELECTORS = [
    '[data-testid="product-tile"]',
    '[data-testid="product-card"]',
    '[class*="ProductTile"]',
    '[class*="product-tile"]',
    '[class*="ProductCard"]',
    'li[class*="product"]',
  ];
  const CANDIDATE_NAME_SELECTORS = [
    '[data-testid="product-title"]',
    '[data-testid="product-name"]',
    '[class*="ProductTitle"]',
    'a[href*="/store/c/"]',
    'a[href*="/product/"]',
  ];
  const CANDIDATE_BRAND_SELECTORS = [
    '[data-testid="product-brand"]',
    '[class*="Brand"]',
  ];
  const CANDIDATE_SALE_PRICE_SELECTORS = [
    '[data-testid="product-price"]',
    '[data-testid="price"]',
    '[class*="salePrice"]',
    '[class*="Price"]',
  ];
  const CANDIDATE_REGULAR_PRICE_SELECTORS = [
    '[data-testid="regular-price"]',
    '[data-testid="was-price"]',
    '[class*="RegularPrice"]',
    '[class*="WasPrice"]',
    's',
  ];
  // The "Buy 1 Get 1 50% off" / "$2 off" badge text, wherever it lives on
  // the tile — checked wherever it's found, so the wrapping element's exact
  // class doesn't matter much.
  const CANDIDATE_DEAL_SELECTORS = [
    '[data-testid="promotion"]',
    '[data-testid="offer-badge"]',
    '[class*="Promo"]',
    '[class*="Offer"]',
    '[class*="Badge"]',
  ];
  const CANDIDATE_IMAGE_SELECTORS = ['img'];

  function makeOverlay() {
    const el = document.createElement('div');
    el.id = 'coupon-bunch-walgreens-weeklyad-overlay';
    el.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:999999',
      'background:#1b1b1b', 'color:#fff', 'font:13px/1.4 -apple-system,sans-serif',
      'padding:12px 16px', 'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      'max-width:280px',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function setStatus(overlay, text) {
    overlay.textContent = text;
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

  function guessBrand(name) {
    if (!name) return '';
    return name.split(/\s+/).slice(0, 1).join(' ');
  }

  function extractId(card) {
    const link = card.querySelector('a[href*="/product/"]') || card.querySelector('a[href]');
    if (!link) return null;
    const href = link.getAttribute('href') || '';
    const m = href.match(/\/(?:prod|product)(?:uct)?\/([\w-]+)/i) || href.match(/sku[=/]([\w-]+)/i);
    return m ? m[1] : href;
  }

  function scrapeCards() {
    const cards = firstMatching(CANDIDATE_CARD_SELECTORS);
    const items = [];

    for (const card of cards) {
      const nameEl = firstMatching(CANDIDATE_NAME_SELECTORS, card)[0];
      const brandEl = firstMatching(CANDIDATE_BRAND_SELECTORS, card)[0];
      const salePriceEl = firstMatching(CANDIDATE_SALE_PRICE_SELECTORS, card)[0];
      const regularPriceEl = firstMatching(CANDIDATE_REGULAR_PRICE_SELECTORS, card)[0];
      const dealEl = firstMatching(CANDIDATE_DEAL_SELECTORS, card)[0];
      const imgEl = firstMatching(CANDIDATE_IMAGE_SELECTORS, card)[0];
      const linkEl = card.querySelector('a[href]');

      const name = nameEl ? nameEl.textContent.trim() : '';
      const salePrice = extractPrice(salePriceEl ? salePriceEl.textContent.trim() : '');
      if (!name || salePrice == null) continue;

      items.push({
        id: extractId(card) || `${name}-${salePrice}`,
        name,
        brand: brandEl ? brandEl.textContent.trim() : guessBrand(name),
        sale_price: salePrice,
        regular_price: extractPrice(regularPriceEl ? regularPriceEl.textContent.trim() : ''),
        deal_text: dealEl ? dealEl.textContent.trim() : '',
        image: imgEl ? imgEl.src : null,
        url: linkEl ? new URL(linkEl.getAttribute('href'), location.origin).href : location.href,
      });
    }
    return items;
  }

  function findLoadMoreControl() {
    const candidates = Array.from(document.querySelectorAll('a, button')).filter((el) => {
      const text = (el.textContent || '').trim().toLowerCase();
      return /load more|see more|show more|more (items|deals|products)/i.test(text);
    });
    return candidates.find((el) => el.offsetParent !== null && !el.disabled) || null;
  }

  async function scrapeAllCards(overlay) {
    const byId = new Map();
    let noGrowthRounds = 0;

    for (let round = 1; round <= MAX_ROUNDS && noGrowthRounds < NO_GROWTH_ROUNDS_BEFORE_GIVING_UP; round++) {
      const before = byId.size;
      for (const c of scrapeCards()) byId.set(c.id, c);
      setStatus(overlay, `Loading more items… ${byId.size} found so far…`);

      noGrowthRounds = byId.size > before ? 0 : noGrowthRounds + 1;

      const loadMoreBtn = findLoadMoreControl();
      if (loadMoreBtn) {
        loadMoreBtn.click();
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
      await sleep(WAIT_AFTER_ACTION_MS);
    }

    return Array.from(byId.values());
  }

  // --- main ---
  if (!location.hostname.endsWith('walgreens.com')) {
    const overlay = makeOverlay();
    overlay.textContent = '⚠️ Run this on a walgreens.com Weekly Ad page, not here.';
    return;
  }

  const overlay = makeOverlay();
  setStatus(overlay, 'Scanning for sale items…');
  const items = await scrapeAllCards(overlay);

  if (items.length === 0) {
    overlay.innerHTML =
      '⚠️ No sale items found on this page. The CSS selectors in ' +
      'scrape-walgreens-weeklyad.src.js are unverified guesses — inspect a ' +
      'product tile in DevTools and edit CANDIDATE_CARD_SELECTORS / ' +
      'CANDIDATE_NAME_SELECTORS / CANDIDATE_SALE_PRICE_SELECTORS.';
    console.warn('[CouponBunch] 0 weekly ad items found. Selectors need updating.');
    return;
  }

  const payload = {
    scraped_at: new Date().toISOString(),
    source: 'bookmarklet',
    source_url: location.href,
    items,
  };

  const jsonText = JSON.stringify(payload, null, 2);
  window.__couponBunchWalgreensWeeklyAd = jsonText;

  const openedCopyTab = openCopyTab(
    `CouponBunch — ${items.length} Walgreens Weekly Ad items (copy this)`,
    jsonText
  );

  try {
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'walgreens-weeklyad-raw.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {}
  try {
    await withTimeout(navigator.clipboard.writeText(jsonText), 2000);
  } catch (e) {}

  overlay.innerHTML = openedCopyTab
    ? `✅ ${items.length} item(s) found. A new tab opened with the data — press Ctrl+C there and paste it wherever you need it.`
    : `✅ ${items.length} item(s) found, but the popup was blocked. Allow popups for this site and try again, or check your Downloads folder / clipboard.`;
  console.log(jsonText);
  setTimeout(() => overlay.remove(), 15000);
})();
