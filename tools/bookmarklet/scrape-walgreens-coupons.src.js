/**
 * CouponBunch Walgreens manufacturer-coupons scraping bookmarklet — source
 * (readable) version.
 *
 * Verified against real markup (captured 2026-08) from Walgreens' coupons
 * page: each offer tile's value/brand/description live in separate elements
 * tied together by a shared numeric ID suffix, e.g.
 *   <div id="summary0" title="...">$2 off ONE Product...</div>
 *   <div id="brand0">Some Brand</div>
 *   <div id="desc0">Online only offer...</div>
 * rather than one wrapping "card" element — so instead of guessing a card
 * container (the approach that caused real bugs on the H-E-B side of this
 * project, sweeping in neighboring cards' text), this finds every
 * `[id^="summary"]` element and looks up its `brandN`/`descN` siblings by ID
 * directly. Falls back to the old CANDIDATE_* guess-based approach if no
 * `summaryN` elements are found (e.g. a different page layout).
 *
 * Note: Walgreens truncates long text with a trailing "..." baked directly
 * into both the visible text AND the `title` attribute on these elements —
 * not just CSS ellipsis — so `description` may come through cut off. The
 * `value` chip usually appears early enough in the text to survive.
 *
 * This same page also lists Cash-rewards-style offers ("Earn $X W Cash
 * rewards...") mixed in with plain manufacturer coupons — those are skipped
 * here (see scrape-walgreens-cashrewards.src.js, which can run on this same
 * page and picks up exactly the ones this script skips).
 *
 * Run this on Walgreens' coupons page:
 *   https://www.walgreens.com/offers/offers.jsp?ban=dl_dlsp_MegaMenu_Coupons
 * while logged in.
 *
 * Usage: click the bookmark — it captures the current page's coupons
 * (clicking a "Load more" button if present, or scrolling, to collect all of
 * them) and opens a new tab with the JSON already selected in a text box (no
 * DevTools needed). Press Ctrl+C there, then run:
 *   python tools/import_walgreens_coupons.py --file wherever-you-saved-it.json
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

  // Pure guesses — no real Walgreens coupon-card markup has been seen by
  // this project. Common "coupon"/"offer" naming patterns are listed first.
  const CANDIDATE_CARD_SELECTORS = [
    '[data-testid="coupon-card"]',
    '[data-testid="coupon-tile"]',
    '[data-testid="offer-card"]',
    '[class*="CouponCard"]',
    '[class*="coupon-card"]',
    '[class*="OfferCard"]',
    'li[class*="coupon"]',
  ];
  const CANDIDATE_DESC_SELECTORS = [
    '[data-testid="coupon-description"]',
    '[data-testid="offer-description"]',
    '[class*="Description"]',
    '[class*="Title"]',
    'p',
  ];
  const CANDIDATE_BRAND_SELECTORS = [
    '[data-testid="coupon-brand"]',
    '[class*="Brand"]',
  ];
  const CANDIDATE_EXPIRES_SELECTORS = [
    '[data-testid="coupon-expiration"]',
    '[data-testid="expires"]',
    '[class*="Expir"]',
  ];

  function makeOverlay() {
    const el = document.createElement('div');
    el.id = 'coupon-bunch-walgreens-coupons-overlay';
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

  // Same value-pattern set proven out on H-E-B/Target: dollar-off,
  // percent-off, cents-off, "N for $X", and "Buy N Get $X" phrasings.
  function extractValue(text) {
    let m = (text || '').match(/\$\d+(?:\.\d{2})?\s+off(\s+\d+)?/i);
    if (m) return m[0];
    m = (text || '').match(/\d+%\s+off/i);
    if (m) return m[0];
    m = (text || '').match(/\d+¢\s+off(\s+\d+)?/i);
    if (m) return m[0];
    m = (text || '').match(/\d+\s+for\s+\$\d+(?:\.\d{2})?/i);
    if (m) return m[0];
    m = (text || '').match(/buy\s+\d+,?\s+get\s+\$\d+(?:\.\d{2})?/i);
    return m ? m[0] : '';
  }

  const PREFIX_STRIP_RE = /^(\$\d+(?:\.\d{2})?\s+off\s+|\d+%\s+off\s+|\d+¢\s+off\s+|\d+\s+for\s+\$\d+(?:\.\d{2})?\s+|buy\s+\d+,?\s+get\s+\$\d+(?:\.\d{2})?\s+(?:on|when you buy)?\s*)/i;

  function guessBrand(description) {
    const stripped = description.replace(PREFIX_STRIP_RE, '').trim();
    const m = stripped.match(/^([A-Z][\w'&]*(?:\s+[A-Z][\w'&.]*){0,2})/);
    return m ? m[1] : '';
  }

  function findLoadMoreControl() {
    const candidates = Array.from(document.querySelectorAll('a, button')).filter((el) => {
      const text = (el.textContent || '').trim().toLowerCase();
      return /load more|see more|show more|more (coupons|offers)/i.test(text);
    });
    return candidates.find((el) => el.offsetParent !== null && !el.disabled) || null;
  }

  // Cash-rewards-style offers share this same summary/brand/desc markup —
  // recognized here so this scraper can skip them (they're handled by
  // scrape-walgreens-cashrewards.src.js instead).
  const CASH_REWARD_TEXT_RE = /w\s*cash|cash\s+reward/i;

  function elementText(el) {
    if (!el) return '';
    return (el.getAttribute('title') || el.textContent || '').trim();
  }

  // Primary path: every offer tile has a `summaryN` element (the value
  // chip) with `brandN`/`descN` siblings sharing the same numeric suffix —
  // no card-boundary guessing needed at all.
  function scrapeCardsById() {
    const summaryEls = Array.from(document.querySelectorAll('[id^="summary"]')).filter((el) =>
      /^summary\d+$/.test(el.id)
    );
    const coupons = [];

    for (const summaryEl of summaryEls) {
      const suffix = summaryEl.id.replace('summary', '');
      const brandEl = document.getElementById('brand' + suffix);
      const descEl = document.getElementById('desc' + suffix);

      const summaryText = elementText(summaryEl);
      if (CASH_REWARD_TEXT_RE.test(summaryText)) continue; // handled by the Cash-rewards scraper instead

      const descText = elementText(descEl);
      const value = extractValue(summaryText) || extractValue(descText);
      if (!value) continue; // not a recognizable coupon value — skip

      const container = summaryEl.closest('.card__item') || summaryEl.parentElement;
      const cardText = container ? container.textContent.replace(/\s+/g, ' ').trim() : '';
      const expiresMatch = cardText.match(/Expires\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);

      coupons.push({
        id: 'w' + suffix,
        brand: brandEl ? brandEl.textContent.trim() : guessBrand(descText || summaryText),
        value,
        description: descText || summaryText,
        expires: expiresMatch ? expiresMatch[1] : '',
        // "View details" links are JS dialogs (javascript:void(0)), not real
        // per-coupon URLs — the coupons page itself is the closest thing.
        url: location.href,
      });
    }
    return coupons;
  }

  // Fallback only, used if the page layout doesn't have summaryN/brandN/
  // descN elements at all (e.g. a different Walgreens page variant).
  function scrapeCardsByGuessedSelectors() {
    const cards = firstMatching(CANDIDATE_CARD_SELECTORS);
    const coupons = [];

    for (const card of cards) {
      const descEl = firstMatching(CANDIDATE_DESC_SELECTORS, card)[0];
      const brandEl = firstMatching(CANDIDATE_BRAND_SELECTORS, card)[0];
      const expiresEl = firstMatching(CANDIDATE_EXPIRES_SELECTORS, card)[0];
      const linkEl = card.querySelector('a[href]');

      const cardText = card.textContent.replace(/\s+/g, ' ').trim();
      const description = descEl ? descEl.textContent.trim() : cardText.slice(0, 120);
      const value = extractValue(description) || extractValue(cardText);
      if (!description || !value) continue; // skip non-coupon tiles

      const brand = brandEl ? brandEl.textContent.trim() : guessBrand(description);
      const expiresText = expiresEl ? expiresEl.textContent.trim() : '';
      const expiresMatch = expiresText.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);

      coupons.push({
        id: `${brand}-${description}`.replace(/\s+/g, '-').toLowerCase().slice(0, 60),
        brand,
        value,
        description,
        expires: expiresMatch ? expiresMatch[1] : expiresText,
        url: linkEl ? new URL(linkEl.getAttribute('href'), location.origin).href : location.href,
      });
    }
    return coupons;
  }

  function scrapeCards() {
    const byId = scrapeCardsById();
    return byId.length > 0 ? byId : scrapeCardsByGuessedSelectors();
  }

  async function scrapeAllCards(overlay) {
    const byId = new Map();
    let noGrowthRounds = 0;

    for (let round = 1; round <= MAX_ROUNDS && noGrowthRounds < NO_GROWTH_ROUNDS_BEFORE_GIVING_UP; round++) {
      const before = byId.size;
      for (const c of scrapeCards()) byId.set(c.id, c);
      setStatus(overlay, `Loading more coupons… ${byId.size} found so far…`);

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
    overlay.textContent = '⚠️ Run this on the walgreens.com coupons page, not here.';
    return;
  }

  const overlay = makeOverlay();
  setStatus(overlay, 'Scanning for coupons…');
  const coupons = await scrapeAllCards(overlay);

  if (coupons.length === 0) {
    overlay.innerHTML =
      '⚠️ No coupons found on this page. Neither the summaryN/brandN/descN ' +
      'ID pattern nor the CANDIDATE_* selector fallbacks in ' +
      'scrape-walgreens-coupons.src.js matched anything — inspect a coupon ' +
      'tile in DevTools and update the script.';
    console.warn('[CouponBunch] 0 coupons found. Selectors need updating.');
    return;
  }

  const payload = {
    scraped_at: new Date().toISOString(),
    source: 'bookmarklet',
    source_url: location.href,
    coupons,
  };

  const jsonText = JSON.stringify(payload, null, 2);
  window.__couponBunchWalgreensCoupons = jsonText;

  const openedCopyTab = openCopyTab(
    `CouponBunch — ${coupons.length} Walgreens coupons (copy this)`,
    jsonText
  );

  try {
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'walgreens-coupons-raw.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {}
  try {
    await withTimeout(navigator.clipboard.writeText(jsonText), 2000);
  } catch (e) {}

  overlay.innerHTML = openedCopyTab
    ? `✅ ${coupons.length} coupon(s) found. A new tab opened with the data — press Ctrl+C there and paste it wherever you need it.`
    : `✅ ${coupons.length} coupon(s) found, but the popup was blocked. Allow popups for this site and try again, or check your Downloads folder / clipboard.`;
  console.log(jsonText);
  setTimeout(() => overlay.remove(), 15000);
})();
