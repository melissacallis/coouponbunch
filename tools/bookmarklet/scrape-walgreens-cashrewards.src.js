/**
 * CouponBunch Walgreens Cash rewards scraping bookmarklet — source
 * (readable) version.
 *
 * Verified against real markup (captured 2026-08): Cash-rewards-style
 * offers ("Earn $10 W Cash rewards when y...") turn out to be mixed in with
 * plain manufacturer coupons on Walgreens' regular coupons page, using the
 * same summaryN/brandN/descN ID-linked structure (see the long comment in
 * scrape-walgreens-coupons.src.js) rather than a wrapping "card" element —
 * so this scraper works the same way: find every `[id^="summary"]` element
 * and look up its `brandN`/`descN` siblings by ID, keeping only the ones
 * whose text mentions "W Cash"/"Cash reward" (the ones the coupons scraper
 * skips). Falls back to the old CANDIDATE_* guess-based approach if no
 * `summaryN` elements are found.
 *
 * Note: Walgreens truncates long text with a trailing "..." baked directly
 * into both the visible text AND the `title` attribute — not just CSS
 * ellipsis — so the spend/qty threshold in `parseCashRewardOffer()` often
 * won't be captured even though the dollar amount itself usually is (it
 * appears earlier in the string, before truncation).
 *
 * Run this on Walgreens' Cash rewards / myWalgreens offers page, or the
 * regular coupons page (walgreens.com/offers/offers.jsp?ban=dl_dlsp_MegaMenu_Coupons)
 * — both have shown Cash-rewards-style offers — while logged in.
 *
 * Usage: click the bookmark — it captures the current page's Cash rewards
 * offers (clicking a "Load more" button if present, or scrolling, to collect
 * all of them) and opens a new tab with the JSON already selected in a text
 * box (no DevTools needed). Press Ctrl+C there, then run:
 *   python tools/import_walgreens_cashrewards.py --file wherever-you-saved-it.json
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

  // Pure guesses — no real Walgreens Cash rewards markup has been seen by
  // this project. "Walgreens Cash" / "myWalgreens" / generic "reward"
  // naming patterns are listed first.
  const CANDIDATE_CARD_SELECTORS = [
    '[data-testid="cashback-offer"]',
    '[data-testid="reward-offer"]',
    '[data-testid="offer-card"]',
    '[class*="CashRewards"]',
    '[class*="WagsCash"]',
    '[class*="RewardOffer"]',
    '[class*="OfferCard"]',
    'li[class*="offer"]',
  ];
  const CANDIDATE_DESC_SELECTORS = [
    '[data-testid="offer-description"]',
    '[class*="Description"]',
    '[class*="Title"]',
    'p',
  ];
  const CANDIDATE_BRAND_SELECTORS = [
    '[data-testid="offer-brand"]',
    '[class*="Brand"]',
  ];

  function makeOverlay() {
    const el = document.createElement('div');
    el.id = 'coupon-bunch-walgreens-cashrewards-overlay';
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

  // "Earn $X W Cash rewards when y..." is the real observed phrasing — the
  // amount comes right after "Earn", before the text gets truncated, so
  // it's checked first. Because of that truncation, the trailing
  // spend/qty clause is often missing entirely (captured as undefined
  // below, which is fine — the amount alone is still worth showing). The
  // other patterns are speculative fallbacks for phrasing not yet observed,
  // mirroring the two real phrasings Target turned out to use for its own
  // gift-card promos.
  function parseCashRewardOffer(text) {
    if (!text) return null;
    let m = text.match(/earn\s+\$(\d+(?:\.\d{2})?)\s+w\s*cash\s+rewards?(?:\s+when\s+you\s+(?:spend\s+\$(\d+(?:\.\d{2})?)|buy\s+(\d+)))?/i);
    if (m) {
      if (m[2] != null) return { type: 'spend', threshold: parseFloat(m[2]), amount: parseFloat(m[1]) };
      if (m[3] != null) return { type: 'qty', qty: parseInt(m[3], 10), amount: parseFloat(m[1]) };
      return { type: 'earn', amount: parseFloat(m[1]) };
    }
    m = text.match(/spend\s+\$(\d+(?:\.\d{2})?),?\s+get\s+\$(\d+(?:\.\d{2})?)\s+walgreens\s+cash/i);
    if (m) return { type: 'spend', threshold: parseFloat(m[1]), amount: parseFloat(m[2]) };
    m = text.match(/buy\s+(\d+),?\s+get\s+\$(\d+(?:\.\d{2})?)\s+walgreens\s+cash/i);
    if (m) return { type: 'qty', qty: parseInt(m[1], 10), amount: parseFloat(m[2]) };
    m = text.match(/\$(\d+(?:\.\d{2})?)\s+walgreens\s+cash\s+with\s+\$(\d+(?:\.\d{2})?)\s+purchase/i);
    if (m) return { type: 'spend', threshold: parseFloat(m[2]), amount: parseFloat(m[1]) };
    m = text.match(/\$(\d+(?:\.\d{2})?)\s+walgreens\s+cash\s+with\s+(\d+)\s+[\w\s]*?items?/i);
    if (m) return { type: 'qty', qty: parseInt(m[2], 10), amount: parseFloat(m[1]) };
    return null;
  }

  const PREFIX_STRIP_RE = /^(earn\s+\$\d+(?:\.\d{2})?\s+w\s*cash\s+rewards?\s+(?:when\s+you\s+(?:spend\s+\$\d+(?:\.\d{2})?|buy\s+\d+))?\s*(?:on)?\s*|spend\s+\$\d+(?:\.\d{2})?,?\s+get\s+\$\d+(?:\.\d{2})?\s+walgreens\s+cash\s+(?:on|when you buy)?\s*|buy\s+\d+,?\s+get\s+\$\d+(?:\.\d{2})?\s+walgreens\s+cash\s+(?:on|when you buy)?\s*|\$\d+(?:\.\d{2})?\s+walgreens\s+cash\s+with\s+(?:\$\d+(?:\.\d{2})?|\d+)\s+[\w\s]*?(?:purchase|items?)\s*)/i;

  function guessBrand(description) {
    const stripped = description.replace(PREFIX_STRIP_RE, '').trim();
    const m = stripped.match(/^([A-Z][\w'&]*(?:\s+[A-Z][\w'&.]*){0,2})/);
    return m ? m[1] : '';
  }

  function findLoadMoreControl() {
    const candidates = Array.from(document.querySelectorAll('a, button')).filter((el) => {
      const text = (el.textContent || '').trim().toLowerCase();
      return /load more|see more|show more|more (offers|rewards)/i.test(text);
    });
    return candidates.find((el) => el.offsetParent !== null && !el.disabled) || null;
  }

  function elementText(el) {
    if (!el) return '';
    return (el.getAttribute('title') || el.textContent || '').trim();
  }

  // Primary path: every offer tile has a `summaryN` element with
  // `brandN`/`descN` siblings sharing the same numeric suffix — no card-
  // boundary guessing needed. Keeps only tiles that parse as a Cash-rewards
  // offer (the coupons scraper keeps everything else from this same markup).
  function scrapeCardsById() {
    const summaryEls = Array.from(document.querySelectorAll('[id^="summary"]')).filter((el) =>
      /^summary\d+$/.test(el.id)
    );
    const offers = [];

    for (const summaryEl of summaryEls) {
      const suffix = summaryEl.id.replace('summary', '');
      const brandEl = document.getElementById('brand' + suffix);
      const descEl = document.getElementById('desc' + suffix);

      const summaryText = elementText(summaryEl);
      const descText = elementText(descEl);
      const offer = parseCashRewardOffer(summaryText) || parseCashRewardOffer(descText);
      if (!offer) continue; // not a Cash-rewards offer — the coupons scraper handles it instead

      const description = descText || summaryText;
      offers.push({
        id: 'w' + suffix,
        brand: brandEl ? brandEl.textContent.trim() : guessBrand(description),
        description,
        amount: offer.amount,
        offer_type: offer.type,
        threshold: offer.threshold ?? null,
        qty: offer.qty ?? null,
        // "View details" links are JS dialogs (javascript:void(0)), not
        // real per-offer URLs — the offers page itself is the closest thing.
        url: location.href,
      });
    }
    return offers;
  }

  // Fallback only, used if the page layout doesn't have summaryN/brandN/
  // descN elements at all (e.g. a different Walgreens page variant).
  function scrapeCardsByGuessedSelectors() {
    const cards = firstMatching(CANDIDATE_CARD_SELECTORS);
    const offers = [];

    for (const card of cards) {
      const descEl = firstMatching(CANDIDATE_DESC_SELECTORS, card)[0];
      const brandEl = firstMatching(CANDIDATE_BRAND_SELECTORS, card)[0];
      const linkEl = card.querySelector('a[href]');

      const cardText = card.textContent.replace(/\s+/g, ' ').trim();
      const description = descEl ? descEl.textContent.trim() : cardText.slice(0, 120);
      const offer = parseCashRewardOffer(description) || parseCashRewardOffer(cardText);
      if (!description || !offer) continue; // skip non-cash-reward tiles

      const brand = brandEl ? brandEl.textContent.trim() : guessBrand(description);

      offers.push({
        id: `${brand}-${description}`.replace(/\s+/g, '-').toLowerCase().slice(0, 60),
        brand,
        description,
        amount: offer.amount,
        offer_type: offer.type,
        threshold: offer.threshold ?? null,
        qty: offer.qty ?? null,
        url: linkEl ? new URL(linkEl.getAttribute('href'), location.origin).href : location.href,
      });
    }
    return offers;
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
      setStatus(overlay, `Loading more offers… ${byId.size} found so far…`);

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
    overlay.textContent = '⚠️ Run this on the walgreens.com Cash rewards page, not here.';
    return;
  }

  const overlay = makeOverlay();
  setStatus(overlay, 'Scanning for Cash reward offers…');
  const offers = await scrapeAllCards(overlay);

  if (offers.length === 0) {
    overlay.innerHTML =
      '⚠️ No Cash reward offers found on this page. Either everything here ' +
      'is a plain coupon with no Cash-rewards offers mixed in, or the ' +
      'phrasing patterns in parseCashRewardOffer() (scrape-walgreens-' +
      'cashrewards.src.js) need updating for wording not yet seen.';
    console.warn('[CouponBunch] 0 Cash reward offers found. Selectors need updating.');
    return;
  }

  const payload = {
    scraped_at: new Date().toISOString(),
    source: 'bookmarklet',
    source_url: location.href,
    offers,
  };

  const jsonText = JSON.stringify(payload, null, 2);
  window.__couponBunchWalgreensCashRewards = jsonText;

  const openedCopyTab = openCopyTab(
    `CouponBunch — ${offers.length} Walgreens Cash reward offers (copy this)`,
    jsonText
  );

  try {
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'walgreens-cashrewards-raw.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {}
  try {
    await withTimeout(navigator.clipboard.writeText(jsonText), 2000);
  } catch (e) {}

  overlay.innerHTML = openedCopyTab
    ? `✅ ${offers.length} offer(s) found. A new tab opened with the data — press Ctrl+C there and paste it wherever you need it.`
    : `✅ ${offers.length} offer(s) found, but the popup was blocked. Allow popups for this site and try again, or check your Downloads folder / clipboard.`;
  console.log(jsonText);
  setTimeout(() => overlay.remove(), 15000);
})();
