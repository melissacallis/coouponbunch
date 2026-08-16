/**
 * CouponBunch Target coupons/Circle-offers scraping bookmarklet — source
 * (readable) version.
 *
 * Run this on Target's Circle offers / coupons page (e.g.
 * target.com/circle/offers), while logged in.
 *
 * Selectors below are evidence-based rather than pure guesses: a real
 * target.com product-listing page's "Related deals" carousel (captured
 * 2026-08) uses `[data-test^="item-card-"]` deal tiles with a
 * `[data-test="deal-link"]` anchor whose `aria-label` holds the full offer
 * text (e.g. "Buy 2 for $10 Scrubbing Bubbles toilet bowl cleaner", "$5
 * Target GiftCard with 3 oral care items") — Target reuses this same deal-
 * tile component elsewhere, so it's a reasonable starting point for the
 * dedicated offers page too, though not confirmed against that exact page.
 * If it finds zero coupons, inspect an offer card in DevTools and update
 * the CANDIDATE_* selectors below, then re-run
 * `python tools/bookmarklet/build.py`.
 *
 * Usage: click the bookmark, it captures the current page's offers,
 * scrolling down repeatedly to trigger and collect any lazy-loaded offers
 * further down the page (like the H-E-B coupon scraper does), then
 * downloads "target-coupons-raw.json" (and copies the same JSON to your
 * clipboard as a fallback, in case the browser silently blocks the
 * automatic download — paste it into a new file of that name if so). Then
 * run:
 *   python tools/import_target_coupons.py
 */
(async () => {
  const SCROLL_ROUNDS_BEFORE_GIVING_UP = 4;
  const MAX_SCROLL_ROUNDS = 60;
  const WAIT_AFTER_SCROLL_MS = 1000;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // If a browser doesn't resolve the clipboard-write permission quickly
  // (e.g. the page's user-activation window from the original click has
  // lapsed by the time this runs, after the scroll loop above), awaiting
  // navigator.clipboard.writeText() directly can hang indefinitely with no
  // error — which would silently block the success message and JSON
  // console.log below from ever running. Racing it against a timeout
  // guarantees the rest of the script always completes either way.
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
    ]);
  }

  const CANDIDATE_CARD_SELECTORS = [
    '[data-test^="item-card-"]',
    '[data-test="offer-card"]',
    '[data-test*="OfferCard"]',
    '[class*="OfferCard"]',
    '[class*="offer-card"]',
    'li[class*="offer"]',
  ];
  // The deal tile's own link carries the full offer text in its aria-label
  // regardless of how the visible text is split up internally — that's
  // tried first in scrapeCards() below. These are the visible-text fallbacks.
  const CANDIDATE_DESC_SELECTORS = [
    '[data-test="basket-offers-message"]',
    '[data-test="pbo-title"]',
    '[data-test*="description"]', '[data-test*="title"]', '[class*="Description"]', 'p',
  ];
  const CANDIDATE_SHORT_DESC_SELECTORS = ['[data-test="pbo-short-desc"]'];

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

  // Real offer text doesn't always say "$X off" — "Buy 2 for $10 ..." and
  // "$5 Target GiftCard with 3 oral care items" are both real observed
  // phrasings. A card with none of these isn't a real coupon/gift-card
  // offer (e.g. a plain "$79.99 sale" product tile), so it's skipped.
  function extractValue(text) {
    let m = (text || '').match(/\$\d+(?:\.\d{2})?\s+off/i);
    if (m) return m[0];
    m = (text || '').match(/\d+%\s+off/i);
    if (m) return m[0];
    m = (text || '').match(/buy\s+\d+\s+for\s+\$\d+(?:\.\d{2})?/i);
    if (m) return m[0];
    m = (text || '').match(/\$\d+(?:\.\d{2})?\s+target\s+gift\s?card/i);
    return m ? m[0] : '';
  }

  // No dedicated brand field exists on these deal tiles, so this strips the
  // recognized value-phrase prefix and takes the leading run of capitalized
  // words as an approximate brand (e.g. "Buy 2 for $10 Scrubbing Bubbles
  // toilet bowl cleaner" -> "Scrubbing Bubbles"). Category-wide offers with
  // no single brand (e.g. "...with 3 oral care items") correctly yield ''
  // rather than a wrong guess.
  const PREFIX_STRIP_RE = /^(\$\d+(?:\.\d{2})?\s+off\s+|\d+%\s+off\s+|buy\s+\d+\s+for\s+\$\d+(?:\.\d{2})?\s+|\$\d+(?:\.\d{2})?\s+target\s+gift\s?card\s+with\s+(?:\$\d+(?:\.\d{2})?|\d+)\s+[\w\s]*?(?:purchase|items?)\s*)/i;

  function guessBrand(description) {
    const stripped = description.replace(PREFIX_STRIP_RE, '').trim();
    const m = stripped.match(/^([A-Z][\w'&]*(?:\s+[A-Z][\w'&.]*){0,2})/);
    return m ? m[1] : '';
  }

  function scrapeCards() {
    const cards = firstMatching(CANDIDATE_CARD_SELECTORS);
    const coupons = [];

    for (const card of cards) {
      const linkEl = card.querySelector('[data-test="deal-link"]') || card.querySelector('a');
      const ariaText = linkEl ? (linkEl.getAttribute('aria-label') || '').trim() : '';

      const shortDescEl = firstMatching(CANDIDATE_SHORT_DESC_SELECTORS, card)[0];
      const descEl = firstMatching(CANDIDATE_DESC_SELECTORS, card)[0];
      const domText = [shortDescEl, descEl]
        .filter(Boolean)
        .map((el) => el.textContent.trim())
        .join(' ')
        .trim();
      const cardText = card.textContent.replace(/\s+/g, ' ').trim();

      const description = ariaText || domText || cardText.slice(0, 100);
      const value = extractValue(description) || extractValue(cardText);
      if (!description || !value) continue; // skip non-coupon tiles (e.g. plain product sales)

      const brand = guessBrand(description);

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

  // Repeatedly scrolls to the bottom of the page, re-scraping after each
  // scroll to pick up any offer tiles that just lazy-loaded, and stops once
  // several scrolls in a row produce no new offers (or the round cap hits).
  async function scrapeAllCards(overlay) {
    const byId = new Map();
    let noGrowthRounds = 0;

    for (let round = 1; round <= MAX_SCROLL_ROUNDS && noGrowthRounds < SCROLL_ROUNDS_BEFORE_GIVING_UP; round++) {
      const before = byId.size;
      for (const c of scrapeCards()) byId.set(c.id, c);
      setStatus(overlay, `Scrolling for more offers… ${byId.size} found so far…`);

      noGrowthRounds = byId.size > before ? 0 : noGrowthRounds + 1;

      window.scrollTo(0, document.body.scrollHeight);
      await sleep(WAIT_AFTER_SCROLL_MS);
    }

    return Array.from(byId.values());
  }

  // --- main ---
  if (!location.hostname.endsWith('target.com')) {
    const overlay = makeOverlay();
    overlay.textContent = '⚠️ Run this on a target.com offers/coupons page, not here.';
    return;
  }

  const overlay = makeOverlay();
  setStatus(overlay, 'Scanning for offers…');
  const coupons = await scrapeAllCards(overlay);

  if (coupons.length === 0) {
    overlay.innerHTML =
      '⚠️ No offers found on this page. The CSS selectors in ' +
      'scrape-target-coupons.src.js likely need updating for Target\'s current ' +
      'markup — inspect an offer card and edit CANDIDATE_CARD_SELECTORS / ' +
      'CANDIDATE_DESC_SELECTORS / CANDIDATE_SHORT_DESC_SELECTORS.';
    console.warn('[CouponBunch] 0 offers found. Selectors may need updating.');
    return;
  }

  const payload = {
    scraped_at: new Date().toISOString(),
    source: 'bookmarklet',
    source_url: location.href,
    coupons,
  };

  const jsonText = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'target-coupons-raw.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  // Some browsers silently block a bookmarklet-triggered download with no
  // visible warning. Copying to the clipboard too means there's always a
  // way to get the data out, even if the file never appears anywhere.
  let clipboardNote = '';
  try {
    await withTimeout(navigator.clipboard.writeText(jsonText), 2000);
    clipboardNote = ' Also copied to your clipboard — if no file downloaded, paste it into a new file named target-coupons-raw.json.';
  } catch (e) {
    // clipboard permission denied, unsupported, or timed out — the download
    // attempt above and the console.log below are still available
  }

  overlay.innerHTML = `✅ ${coupons.length} offer(s) saved to target-coupons-raw.json.${clipboardNote}<br><br>Now run: python tools/import_target_coupons.py`;
  // Third fallback, in case both the download and the clipboard copy are
  // blocked: the full JSON is always available by scrolling up in the
  // Console after the overlay above confirms how many offers were found.
  console.log(jsonText);
  setTimeout(() => overlay.remove(), 15000);
})();
