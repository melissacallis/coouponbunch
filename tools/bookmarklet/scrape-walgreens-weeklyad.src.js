/**
 * CouponBunch Walgreens Weekly Ad scraping bookmarklet — source (readable)
 * version.
 *
 * Verified against real markup (captured 2026-08): every "Deals of the
 * Week" tile — both the standard `offer-card-v2` style and the bigger
 * `teaser-card` hero style — is a `[role="group"]` whose `aria-label`
 * reads "product <full name>", which is the most robust way to get the
 * name regardless of which card variant it is. A stable `offer-id`
 * attribute on the same element gives a real unique ID (no card-boundary
 * guessing needed). Price lives in `.offer-price-text` as separate
 * `.integer-part`/`.fraction-part` spans (no literal "." in the text, so
 * they're joined manually). Some tiles carry their own bonus signals right
 * on the card:
 *   - `.cash-offer .ao-title`/`.ao-subtitle` — an in-store myWalgreens
 *     rewards line, e.g. "Earn $3 In-store rewards" + "when you buy 2".
 *     This is a DIFFERENT program from the online "W Cash" rewards
 *     scraped by scrape-walgreens-cashrewards.src.js, so it's kept as its
 *     own field here rather than merged with that file's output.
 *   - `.offer-footer .coupon-text` — an embedded manufacturer coupon
 *     right on the tile itself (e.g. "$1 off online coupon"), which is a
 *     much more reliable stack signal than brand-matching against the
 *     separate coupons list, so it's captured directly as
 *     `embedded_coupon_value`.
 * Falls back to the old CANDIDATE_* guess-based approach if no
 * `[role="group"][aria-label^="product "]` elements are found (e.g. a
 * different page variant).
 *
 * Run this on Walgreens' "Deals of the Week" / Weekly Ad page, while
 * logged in with your store selected.
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
    let m = (text || '').match(/\$(\d+(?:\.\d{2})?)/);
    if (m) return parseFloat(m[1]);
    m = (text || '').match(/(\d+)¢/);
    if (m) return parseFloat(m[1]) / 100;
    return null;
  }

  // The dollar amount is split across separate .integer-part/.fraction-part
  // spans with no literal "." in the text (e.g. "4" and "99" rendered next
  // to each other as "$4.99") — read them individually and join, falling
  // back to a plain regex over the whole element's text for other price
  // formats (multi-buy "2/$12", cents "88¢", ranges "$7 to $13", etc. — the
  // regex just grabs the first dollar/cents amount it finds in those cases).
  function extractPriceFromEl(priceEl) {
    if (!priceEl) return null;
    const intPart = priceEl.querySelector('.integer-part');
    if (intPart) {
      const fracPart = priceEl.querySelector('.fraction-part');
      const intText = intPart.textContent.trim();
      const fracText = fracPart ? fracPart.textContent.trim() : '';
      const combined = fracText ? `${intText}.${fracText}` : intText;
      const val = parseFloat(combined);
      if (!isNaN(val)) return val;
    }
    return extractPrice(priceEl.textContent.replace(/\s+/g, ' ').trim());
  }

  // Strips a leading pack-size/quantity phrase ("12-Pack ", "24-Pack ",
  // "Value Pack ") before guessing the brand from what's left — otherwise
  // "12-Pack Pepsi Products" would guess "12-Pack" as the brand instead of
  // "Pepsi" (confirmed against real Weekly Ad data). Also strips trailing
  // punctuation from the guessed word (e.g. "Downy," -> "Downy") so it
  // doesn't silently break prefix-based brand matching against a clean
  // coupon brand string.
  function guessBrand(name) {
    if (!name) return '';
    const stripped = name.replace(/^(\d+[\s-]?pack|value\s+pack)\s+/i, '');
    const words = stripped.split(/\s+/);
    const firstWord = (words[0] || '').replace(/[,;:]+$/, '');
    // "Walgreens" alone is too generic to use as a brand — it's the
    // store's own name, prefixed onto dozens of unrelated private-label
    // lines (Certainty, TRUE METRIX, pregnancy tests, blood pressure
    // monitors...). Confirmed as a real bug against live data: it falsely
    // matched a "$2 off Walgreens Pregnancy Tests" coupon onto a blood
    // pressure monitor and 8 other unrelated items. Taking more words
    // requires real specificity before it's allowed to match anything.
    if (/^walgreens$/i.test(firstWord)) {
      return words.slice(0, 3).join(' ').replace(/[,;:]+$/, '');
    }
    return firstWord;
  }

  const IN_STORE_REWARD_RE = /Earn\s+\$(\d+(?:\.\d{2})?)\s+In-?store\s+rewards?/i;
  const IN_STORE_QTY_RE = /buy\s+(\d+)/i;

  function scrapeCardsById() {
    const cards = Array.from(document.querySelectorAll('[role="group"][aria-label^="product "]'));
    const items = [];

    for (const card of cards) {
      const ariaLabel = card.getAttribute('aria-label') || '';
      const nameFromAria = ariaLabel.replace(/^product\s+/i, '').trim();
      const headlineEl = card.querySelector('.headline');
      const name = nameFromAria || (headlineEl ? headlineEl.textContent.trim() : '');
      if (!name) continue;

      const priceEl = card.querySelector('.offer-price-text');
      const salePrice = extractPriceFromEl(priceEl);
      if (salePrice == null) continue;

      const imgEl = card.querySelector('.product-image') || card.querySelector('img');

      const aoTitleEl = card.querySelector('.cash-offer .ao-title');
      const aoSubtitleEl = card.querySelector('.cash-offer .ao-subtitle');
      const aoText = [aoTitleEl, aoSubtitleEl]
        .filter(Boolean)
        .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
        .join(' ')
        .trim();
      const inStoreMatch = aoText.match(IN_STORE_REWARD_RE);
      const inStoreQtyMatch = aoText.match(IN_STORE_QTY_RE);

      const couponTextEl = card.querySelector('.offer-footer .coupon-text');
      const embeddedCouponText = couponTextEl ? couponTextEl.textContent.replace(/\s+/g, ' ').trim() : '';
      const embeddedCouponValue = extractValueFromText(embeddedCouponText);

      items.push({
        id: card.getAttribute('offer-id') || `${name}-${salePrice}`,
        name,
        brand: guessBrand(name),
        sale_price: salePrice,
        regular_price: null,
        deal_text: aoText || '',
        in_store_reward_amount: inStoreMatch ? parseFloat(inStoreMatch[1]) : null,
        in_store_reward_qty: inStoreQtyMatch ? parseInt(inStoreQtyMatch[1], 10) : null,
        embedded_coupon_text: embeddedCouponText || null,
        embedded_coupon_value: embeddedCouponValue || null,
        image: imgEl ? imgEl.src : null,
        // "Shop products" opens an in-page dialog, not a real per-item URL —
        // the Weekly Ad page itself is the closest thing.
        url: location.href,
      });
    }
    return items;
  }

  // Same dollar/percent/cents/"N for $" patterns proven out on H-E-B/Target,
  // used here for the embedded coupon pill's own text (e.g. "$1 off online
  // coupon").
  function extractValueFromText(text) {
    let m = (text || '').match(/\$\d+(?:\.\d{2})?\s+off(\s+\d+)?/i);
    if (m) return m[0];
    m = (text || '').match(/\d+%\s+off/i);
    if (m) return m[0];
    m = (text || '').match(/\d+¢\s+off(\s+\d+)?/i);
    return m ? m[0] : '';
  }

  function extractId(card) {
    const link = card.querySelector('a[href*="/product/"]') || card.querySelector('a[href]');
    if (!link) return null;
    const href = link.getAttribute('href') || '';
    const m = href.match(/\/(?:prod|product)(?:uct)?\/([\w-]+)/i) || href.match(/sku[=/]([\w-]+)/i);
    return m ? m[1] : href;
  }

  // Fallback only, used if the page layout doesn't have
  // [role="group"][aria-label^="product "] tiles at all (e.g. a different
  // Walgreens page variant).
  function scrapeCardsByGuessedSelectors() {
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
        in_store_reward_amount: null,
        in_store_reward_qty: null,
        embedded_coupon_text: null,
        embedded_coupon_value: null,
        image: imgEl ? imgEl.src : null,
        url: linkEl ? new URL(linkEl.getAttribute('href'), location.origin).href : location.href,
      });
    }
    return items;
  }

  function scrapeCards() {
    const byId = scrapeCardsById();
    return byId.length > 0 ? byId : scrapeCardsByGuessedSelectors();
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
      '⚠️ No sale items found on this page. Neither the ' +
      '[role="group"][aria-label^="product "] tile pattern nor the ' +
      'CANDIDATE_* selector fallbacks in scrape-walgreens-weeklyad.src.js ' +
      'matched anything — inspect a product tile in DevTools and update ' +
      'the script.';
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
