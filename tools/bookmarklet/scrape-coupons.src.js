/**
 * CouponBunch coupon-scraping bookmarklet — source (readable) version.
 *
 * Run this on H-E-B's "All coupons" page (heb.com/digital-coupon/...) while
 * logged in. It reads the page's own rendered DOM (not a fetch from
 * scratch), walking through pagination the same way a human would — click
 * "Next" if present, otherwise scroll for infinite-scroll pages — so it
 * works regardless of which pagination style H-E-B is using this week, and
 * it inherits your real browser session/cookies, which is what lets it get
 * past H-E-B's bot protection where server-side scraping gets blocked.
 *
 * Usage: see tools/bookmarklet/README.md. In short — either drag the
 * generated bookmarklet link (tools/bookmarklet/README.md, built by
 * build.py) to your bookmarks bar and click it on the coupon page, or paste
 * this file's contents directly into the browser DevTools Console on that
 * page (identical effect).
 *
 * When it finishes, it opens a new tab with the JSON already selected in a
 * text box — Ctrl+C copies it immediately, no Downloads-folder hunting or
 * DevTools needed (a plain file download is still attempted as a silent
 * bonus underneath, in case that works fine in your browser). Save it as
 * heb-coupons-raw.json, then run: python tools/import_coupons.py
 */
(async () => {
  const CARD_SELECTOR = 'a[href*="/digital-coupon/coupon-detail/"]';
  const MAX_PAGES = 30;
  const SCROLL_ROUNDS_BEFORE_GIVING_UP = 3;
  const WAIT_AFTER_ACTION_MS = 1500;

  function makeOverlay() {
    const el = document.createElement('div');
    el.id = 'coupon-bunch-scraper-overlay';
    el.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:999999',
      'background:#1b1b1b', 'color:#fff', 'font:13px/1.4 -apple-system,sans-serif',
      'padding:12px 16px', 'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      'max-width:280px',
    ].join(';');
    el.textContent = 'CouponBunch scraper starting…';
    document.body.appendChild(el);
    return el;
  }

  function setStatus(overlay, text) {
    overlay.textContent = text;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function extractIdFromHref(href) {
    const m = href.match(/coupon-detail\/(\d+)/);
    return m ? m[1] : href;
  }

  // Basket coupons ("$X off your basket when you buy $Y of ...") get a
  // clean short chip like "$5 off $25" built from the two amounts, rather
  // than returning the whole matched sentence.
  //
  // For everything else, real dollar/percent/cents/"N for $" value patterns
  // are checked BEFORE "Combo Loco" specifically, and the coupon's own title
  // text is checked before the wider card container — walking up parent
  // elements to find a card's boundaries is inherently approximate, and can
  // sweep in a neighboring card's "Combo Loco" badge; letting a specific
  // dollar/percent match win avoids that coupon being mislabeled just
  // because stray badge text happened to appear in the scanned region.
  function extractValue(title, cardText) {
    let m = title.match(/\$(\d+(?:\.\d{2})?)\s+off\s+your\s+basket\s+when\s+you\s+buy\s+\$(\d+(?:\.\d{2})?)/i);
    if (m) return `$${m[1]} off $${m[2]}`;

    // "Save $2.00 on ONE Dove..." is a common alternate phrasing for a flat
    // dollar-off coupon — normalize it to "$2.00 off" so it still matches
    // the "$X off" pattern the savings-calculator logic looks for.
    m = title.match(/Save\s+\$(\d+(?:\.\d{2})?)/i);
    if (m) return `$${m[1]} off`;

    const patterns = [
      /\$\d+(?:\.\d{2})?\s+off(\s+\d+)?/i,
      /\d+%\s+off/i,
      /\d+¢\s+off(\s+\d+)?/i,
      /\d+\s+for\s+\$\d+/i,
      /Combo Loco/i,
    ];
    for (const source of [title, cardText]) {
      for (const pattern of patterns) {
        const found = source.match(pattern);
        if (found) return found[0];
      }
    }
    return '';
  }

  function parseCardsFromDOM() {
    const links = Array.from(document.querySelectorAll(CARD_SELECTOR));
    const coupons = [];

    for (const link of links) {
      const title = (link.textContent || '').trim();
      const href = link.getAttribute('href') || '';
      if (!title || !href) continue;

      let card = link.parentElement;
      for (let i = 0; i < 4 && card && card.parentElement; i++) {
        card = card.parentElement;
      }
      const cardText = card ? card.textContent.replace(/\s+/g, ' ').trim() : '';

      // H-E-B's card text runs the expiry straight into the next label with
      // no separating space (e.g. "Expires 8/25/2026Unlimited use"), so a
      // greedy [\w/]+ match would swallow "Unlimited"/"Limit" right along
      // with the date. Capture only a date or weekday name explicitly, so
      // it can't run past the actual expiry value.
      const expiresMatch = cardText.match(/Expires\s+(\d{1,2}\/\d{1,2}\/\d{2,4}|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/i);
      const limit = cardText.includes('Limit 1 per customer') ? 'Limit 1 per customer' : 'Unlimited use';
      const fullUrl = href.startsWith('/') ? 'https://www.heb.com' + href : href;

      coupons.push({
        id: extractIdFromHref(href),
        value: extractValue(title, cardText),
        description: title,
        expires: expiresMatch ? expiresMatch[1] : '',
        limit,
        url: fullUrl,
      });
    }

    const seen = new Set();
    return coupons.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }

  function findNextControl() {
    const candidates = Array.from(document.querySelectorAll('a, button')).filter((el) => {
      const text = (el.textContent || '').trim().toLowerCase();
      return text === 'next' || text === 'next page';
    });
    return candidates.find((el) => el.offsetParent !== null) || null; // visible only
  }

  async function scrollAndWaitForGrowth(previousCount) {
    for (let i = 0; i < SCROLL_ROUNDS_BEFORE_GIVING_UP; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1200);
      const count = document.querySelectorAll(CARD_SELECTOR).length;
      if (count > previousCount) return count;
    }
    return document.querySelectorAll(CARD_SELECTOR).length;
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

  // File downloads triggered from a bookmarklet get silently blocked in some
  // browser setups with no visible warning at all. This sidesteps that
  // entirely: opens a new tab with the JSON already selected in a text box,
  // so the user just presses Ctrl+C and pastes it wherever they need it —
  // no DevTools required.
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

  // --- main ---
  const overlay = makeOverlay();

  if (!location.hostname.endsWith('heb.com')) {
    setStatus(overlay, '⚠️ Run this on a heb.com coupon page, not here.');
    return;
  }

  let allCoupons = [];
  const byId = new Map();
  let pagesWalked = 0;

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    pagesWalked = pageNum;
    const pageCoupons = parseCardsFromDOM();

    if (pageNum === 1 && pageCoupons.length === 0) {
      setStatus(
        overlay,
        '⚠️ No coupon cards found on this page. Make sure you\'re on the ' +
          'All Coupons page and it has finished loading, then try again.'
      );
      return;
    }

    for (const c of pageCoupons) byId.set(c.id, c);
    setStatus(overlay, `Page ${pageNum} — ${byId.size} coupons found so far…`);

    const nextControl = findNextControl();
    if (nextControl) {
      nextControl.click();
      await sleep(WAIT_AFTER_ACTION_MS);
      continue;
    }

    const currentCount = document.querySelectorAll(CARD_SELECTOR).length;
    const grownCount = await scrollAndWaitForGrowth(currentCount);
    if (grownCount <= currentCount) {
      setStatus(overlay, `Reached the end — ${byId.size} coupons total. Saving file…`);
      break;
    }
  }

  allCoupons = Array.from(byId.values());

  const payload = {
    scraped_at: new Date().toISOString(),
    source: 'bookmarklet',
    source_url: location.href,
    pages_scraped: pagesWalked,
    coupons: allCoupons,
  };

  const openedCopyTab = openCopyTab(
    `CouponBunch — ${allCoupons.length} H-E-B coupons (copy this)`,
    JSON.stringify(payload, null, 2)
  );
  try {
    downloadJSON('heb-coupons-raw.json', payload); // best-effort bonus, silent if blocked
  } catch (e) {}

  setStatus(
    overlay,
    openedCopyTab
      ? `✅ ${allCoupons.length} coupons found. A new tab opened with the data — press Ctrl+C there and paste it wherever you need it.`
      : `✅ ${allCoupons.length} coupons found, but the popup was blocked. Allow popups for this site and try again, or check your Downloads folder.`
  );
  setTimeout(() => overlay.remove(), 15000);
})();
