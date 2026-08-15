/**
 * CouponBunch — stacking engine + UI.
 *
 * Data flow: coupons.json (always present) + prices.json (often empty until
 * the price bookmarklet has been run — everything here must degrade
 * gracefully when it is). localStorage holds any prices the visitor types
 * in by hand, which fill the same gaps.
 */

let DATA = { featured_stackable_candidates: [], general_coupons: [] };
let PRICES = { products: {} };
let PRICE_OVERRIDES = {}; // { [couponId]: number }, persisted to localStorage
let ITEM_NOTES = {}; // { [couponId]: [{id, name, price, addedAt}] }, persisted to localStorage

const PRICE_OVERRIDES_KEY = 'heb-price-overrides';
const ITEM_NOTES_KEY = 'heb-item-notes';

/* ============================== Engine ================================ */

// Pulls the qualifying-brand/category clause out of a basket coupon's
// description, e.g. "...buy $25 of Dove, AXE, or Schmidt's items" ->
// ["Dove", "AXE", "Schmidt's"]. Mirrors heb_lib/classify.py's
// extract_qualifying_items so scrape-time and browse-time logic agree.
const QUALIFYING_CLAUSE_RE = /buy\s+\$\d+(?:\.\d{2})?\s+of\s+(.+?)(?:\s+items?\b|\s+products?\b|\s*\(|$)/i;

// A poorly-terminated qualifying clause (one that doesn't cleanly end at
// "items"/"products"/"(") can spill into a trailing size/count descriptor,
// e.g. "...buy $25 of Dove, AXE, 20 oz." splitting out "20 oz." as if it
// were a brand name. That's a near-content-free fragment that can spuriously
// substring-match unrelated coupons, so it's filtered out here rather than
// treated as a real qualifying phrase. Mirrors heb_lib/classify.py.
const SIZE_FRAGMENT_RE = /^\d+(\.\d+)?\s*-?\s*\d*(\.\d+)?\s*(oz\.?|ct\.?|lb\.?|fl\.?\s*oz\.?|pk\.?|count|ea\.?|each|g|ml|qt\.?)\.?$/i;

// Trailing filler like "assorted varieties" carries no brand/category
// signal at all — it shows up in nearly every coupon's description, so
// treating it as a qualifying phrase turns it into a false "strong" match
// against hundreds of unrelated coupons (confirmed against real data: 457).
const NOISE_PHRASE_RE = /^(assorted|various|select)?\s*(varieties|flavors|sizes|selections?)$/i;

function isSizeFragment(phrase) {
  return SIZE_FRAGMENT_RE.test(phrase) || NOISE_PHRASE_RE.test(phrase) || phrase.replace(/[^A-Za-z]/g, '').length < 3;
}

function extractQualifyingItems(description) {
  const m = (description || '').match(QUALIFYING_CLAUSE_RE);
  if (!m) return [];
  return m[1]
    .split(/,|\bor\b|\band\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && !isSizeFragment(s));
}

// Generic merchandising-category nouns that ride along in a qualifying-items
// clause (e.g. "...Schmidt's Personal Cleansing, Deodorant, Lotion... items").
// A match on one of these alone is a weaker signal than a brand/product-line
// name, so it's downgraded to "possible" rather than "strong" — otherwise
// every unrelated deodorant coupon would look like a confident match.
// Unlike a brand dictionary, this list doesn't need a new entry every time
// H-E-B runs a coupon on a new brand — only when a genuinely new *category
// noun* shows up, which is rare.
const GENERIC_CATEGORY_WORDS = new Set([
  'items', 'item', 'products', 'product', 'select items', 'varieties', 'variety',
  'personal cleansing', 'deodorant', 'lotion', 'hair care', 'face care', 'hand soap',
  'body wash', 'vitamins', 'supplements', 'probiotics', 'school supplies',
  'office supplies', 'snacks', 'snack bars', 'granola', 'cereal', 'yogurt', 'chips',
  'candy', 'beverages', 'cleaning supplies', 'paper products', 'baby care',
  'pet care', 'health care', 'soap', 'skin care', 'oral care', 'laundry',
  'household', 'frozen', 'breakfast', 'condiments', 'sauces', 'baking',
]);

function isGenericPhrase(phrase) {
  return GENERIC_CATEGORY_WORDS.has(phrase.trim().toLowerCase());
}

// Fallback/canonicalization dictionary — used only when a coupon's
// description doesn't parse into a clean qualifying-items clause (e.g. it
// isn't a basket coupon at all) or as a secondary signal alongside a
// qualifying-phrase match. The qualifying-items extraction above is the
// primary, self-updating signal; this dictionary is a maintained assist,
// not the only source of matches.
const BRAND_DICTIONARY = [
  "Kenvue","Neutrogena","Aveeno","OGX","Tylenol","Zarbee's","Zarbees","Listerine",
  "Kodiak","Buldak",
  "Dove Men+Care","Dove","AXE","Degree","TRESemme","SheaMoisture","Vaseline",
  "Olly","Schmidt's",
  "Nature's Truth","Nature's Bounty","Nature's Own","Nature's Bakery",
  "Depend","Poise",
  "The Honest Company","Honest Company",
  "Beech-Nut",
  "AZO","Culturelle","Estroven",
  "Kitsch",
  "Muscle Milk","Gatorade","Evolve",
  "SlimFast",
  "Camille Rose",
  "Garnier Fructis","Garnier Whole Blends","Garnier Nutrisse","Garnier",
  "Febreze","Secret","Old Spice","Gillette","Clairol","Cremo","Bulldog",
  "Kotex","U by Kotex","Tillamook","L'OREAL","L'Oreal Paris","Elvive",
  "Cascade","OxiClean","Pentel","Bonne Maman",
  "Central Market","Colgate","Betty Crocker","Huggies","Skippy",
  "Earth's Best","Fresh Gourmet","Natural Vitality","Neocell","Rainbow Light",
  "Lakewood","Mr. Clean","Pillsbury","ARM & HAMMER","Crest",
  "MorningStar Farms","The New Primal","Jimmy Dean","KA-ME","Oral-B",
  "Cottonelle","Ozarka","Emergen-C","Evermark","Suave","Pond's","Caress",
  "ChapStick","Q-Tip","St. Ives","Noxzema","Gold Peak","Bai","ACT",
  "Glade","Post-it","Nexxus","Honey Stinger","Lysol","Planet Oat",
  "Persil","Purex","Scott","AriZona","Kibbles 'n Bits","Think!",
  "Quilted Northern","El Monterey","Suja","Bumble Bee","Playtex",
  "Johnsonville","Good Good","DampRid","ZYRTEC","Kikkoman",
  "Annie's","Cellucor","C4","Xtend","Monster Energy",
  "MONDAY","Ortega","Campbell's","Kool-Aid","Country Time","Tang",
  "Hill Country Fare","GOODLES","Applegate","Kid Cuisine",
  "NatureSweet","PURE Zzzs","Hippeas","Goya","Galbani","MOTRIN",
  "good2grow","Bloom","Biore","Right Guard","Allegra","Icy Hot",
  "Raybern's","LUBRIDERM","Refresh","Catalina Crunch","ZzzQuil",
  "Rudi's","State Fair","Jarritos","SoCozy","Organic Valley",
  "Pure Leaf","V8","Cacique","Good Belly","Reddi Wip","Amos Peelerz",
  "Dulcolax","Perfect Bar","Violife","DentaLife","Actual Veggies",
  "Sprayway","Nutpods","Aspercreme","Egglife","Hidden Valley Ranch",
  "Sandwich Bros.","Dole","Spylt","FIXODENT","Lemme","Caltrate","Silk",
  "Play-Doh","Swiffer","Delallo","Mission","Zeiss","Stayfree",
  "Hamburger Helper","Cattleman's","Purnell's","CHI",
  "Welly","Simply Protein","Mack's","Renew Life","Philips Sonicare",
  "Rubbermaid","Veggie Wash","Skinny Girl","Suavitel","Millie Moon",
  "High Brew","OLIPOP","XYZAL","NASACORT","Moontail","Yumi",
  "Bigelow","Unisom","Afrin","TruSkin","Beyond","That's It",
  "Saba","Jones Dairy Farm","Florastor","Macadamia","Pirq",
  "August","Taste Republic","Lesser Evil","Harry's","Good Sense",
  "South 40","Aquage","Copra Coconuts","Koko & Karma",
  "Fancy Feast","Ricos","Pocky","Biz","Coro","Country Crock","Claritin",
  "Lean Body","Palmetto","Hims","Storm","Unbound Snacks","Blue Bottle",
  "Always Discreet","Flamingo",
].sort((a, b) => b.length - a.length); // longest-first so "Dove Men+Care" is
                                        // checked before plain "Dove"

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compiled once at load rather than rebuilt on every findBrandsInText() call
// — with ~300 brands checked against every (featured × general) pair, that
// used to mean rebuilding ~300 RegExp objects millions of times per render.
const BRAND_REGEXES = BRAND_DICTIONARY.map((brand) => ({
  brand,
  re: new RegExp('\\b' + escapeRegExp(brand) + '\\b', 'i'),
}));

function findBrandsInText(description) {
  const found = new Set();
  for (const { brand, re } of BRAND_REGEXES) {
    if (re.test(description)) found.add(brand);
  }
  return found;
}

// A coupon's brand set only depends on its own (unchanging) description, so
// it's cached directly on the coupon object the first time it's computed —
// without this, buildMatches() recomputes the same featured coupon's brand
// set once per general coupon (and vice versa), turning an O(featured +
// general) scan into O(featured × general) and taking ~15s over the real
// dataset instead of well under a second.
function brandsForCoupon(coupon) {
  return coupon._brands || (coupon._brands = findBrandsInText(coupon.description || ''));
}

// Extracts {discount, threshold} dollar amounts from a basket coupon, e.g.
// "$5 off $25 (select items)" or "...buy $25 of..." -> {discount:5, threshold:25}.
function parseBasketThreshold(featured) {
  let m = (featured.value || '').match(/\$(\d+(?:\.\d{2})?)\s+off\s+\$(\d+(?:\.\d{2})?)/i);
  if (m) return { discount: parseFloat(m[1]), threshold: parseFloat(m[2]) };
  m = (featured.description || '').match(
    /\$(\d+(?:\.\d{2})?)\s+off\s+your\s+basket\s+when\s+you\s+buy\s+\$(\d+(?:\.\d{2})?)/i
  );
  if (m) return { discount: parseFloat(m[1]), threshold: parseFloat(m[2]) };
  return null;
}

// Flat-dollar or percent-off coupons have a computable savings amount once
// a price is known; Combo Loco / N-for-$X deals don't reduce to a simple
// per-item number, so they're left out of the running total (still shown,
// just not counted) rather than guessed at.
function parseCouponSavings(coupon, price) {
  let m = (coupon.value || '').match(/\$(\d+(?:\.\d{2})?)\s+off/i);
  if (m) return { amount: parseFloat(m[1]), computable: true };
  m = (coupon.value || '').match(/(\d+)%\s+off/i);
  if (m && price != null) return { amount: price * (parseInt(m[1], 10) / 100), computable: true };
  return { amount: 0, computable: false };
}

function findPriceForCoupon(general, prices) {
  if (!prices || !prices.products) return null;
  const brands = brandsForCoupon(general);
  for (const brand of brands) {
    const entries = prices.products[brand];
    if (entries && entries.length) return { brand, ...entries[0] };
  }
  return null;
}

// A single manufacturer coupon often covers several distinct products (e.g.
// "AXE Deodorant or Body Spray, assorted varieties" spans many SKUs, each
// with its own price). Rather than guess, this collects every product the
// site actually knows about for that coupon: anything the price bookmarklet
// scraped (prices.json), plus anything the visitor has manually logged after
// checking heb.com themselves (ITEM_NOTES, saved forever in their browser —
// so that lookup only ever has to happen once per coupon, not every visit).
function itemsForCoupon(coupon, prices) {
  const items = [];
  const brands = brandsForCoupon(coupon);
  brands.forEach((brand) => {
    const entries = (prices && prices.products && prices.products[brand]) || [];
    entries.forEach((e, i) => {
      items.push({ id: `scraped-${brand}-${i}`, name: e.name, price: e.price, source: 'scraped' });
    });
  });
  (ITEM_NOTES[coupon.id] || []).forEach((n) => {
    items.push({ id: n.id, name: n.name, price: n.price, source: 'manual' });
  });
  return items;
}

function getEffectivePrice(coupon, priceMatch) {
  if (Object.prototype.hasOwnProperty.call(PRICE_OVERRIDES, coupon.id)) {
    return PRICE_OVERRIDES[coupon.id];
  }
  return priceMatch ? priceMatch.price : null;
}

// The core stacking call: does `general` plausibly stack with `featured`,
// and how confident should the site be about it?
function computeConfidence(featured, general, prices) {
  const qualifying = featured._qualifyingItems || (featured._qualifyingItems = extractQualifyingItems(featured.description));

  const specificPhrase = qualifying.find(
    (p) => !isGenericPhrase(p) && new RegExp('\\b' + escapeRegExp(p) + '\\b', 'i').test(general.description)
  );
  const genericPhrase = !specificPhrase && qualifying.find(
    (p) => isGenericPhrase(p) && new RegExp('\\b' + escapeRegExp(p) + '\\b', 'i').test(general.description)
  );

  const featuredBrands = brandsForCoupon(featured);
  const generalBrands = brandsForCoupon(general);
  const brandOverlap = [...featuredBrands].filter((b) => generalBrands.has(b));

  let tier = null;
  const reasons = [];
  if (specificPhrase) {
    tier = 'strong';
    reasons.push(`Both mention "${specificPhrase}"`);
  } else if (brandOverlap.length) {
    tier = 'strong';
    reasons.push(`Shared brand: ${brandOverlap[0]}`);
  } else if (genericPhrase) {
    tier = 'possible';
    reasons.push(`Both are in the "${genericPhrase}" category — check the brand qualifies`);
  }

  if (!tier) return null;

  const priceMatch = findPriceForCoupon(general, prices);
  if (priceMatch) reasons.push(`Priced at ${formatMoney(priceMatch.price)} (${priceMatch.name})`);

  return { tier, priceMatch, reasons };
}

function buildMatches(featured, generalList, prices) {
  const matches = [];
  for (const general of generalList) {
    const confidence = computeConfidence(featured, general, prices);
    if (confidence) matches.push({ coupon: general, ...confidence });
  }
  matches.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'strong' ? -1 : 1));
  return matches;
}

// Ranks featured basket coupons by "% back" (discount ÷ threshold) among
// only those with at least one confirmed (strong-tier) manufacturer-coupon
// match — i.e. a stack that's genuinely usable today, not just a basket
// coupon sitting there with nothing to pair it with.
function computeBestStacks(data, prices, maxResults = 8) {
  const results = [];
  for (const featured of data.featured_stackable_candidates || []) {
    const threshold = parseBasketThreshold(featured);
    if (!threshold || threshold.threshold <= 0) continue;
    const matches = buildMatches(featured, data.general_coupons || [], prices);
    const strongMatches = matches.filter((m) => m.tier === 'strong');
    if (!strongMatches.length) continue;
    const percentBack = (threshold.discount / threshold.threshold) * 100;
    results.push({ featured, threshold, percentBack, strongMatches });
  }
  results.sort((a, b) => b.percentBack - a.percentBack);
  return results.slice(0, maxResults);
}

function computeHeroStack(data, prices) {
  let best = null;
  for (const featured of data.featured_stackable_candidates || []) {
    const threshold = parseBasketThreshold(featured);
    if (!threshold) continue;
    const matches = buildMatches(featured, data.general_coupons || [], prices);
    const priced = matches.filter((m) => getEffectivePrice(m.coupon, m.priceMatch) != null);
    const subtotal = priced.reduce((s, m) => s + getEffectivePrice(m.coupon, m.priceMatch), 0);
    if (subtotal < threshold.threshold) continue;

    const generalSavings = priced.reduce((s, m) => {
      const price = getEffectivePrice(m.coupon, m.priceMatch);
      const sav = parseCouponSavings(m.coupon, price);
      return s + (sav.computable ? sav.amount : 0);
    }, 0);
    const totalSavings = generalSavings + threshold.discount;

    if (!best || totalSavings > best.totalSavings) {
      best = { featured, subtotal, totalSavings, itemCount: priced.length };
    }
  }
  return best;
}

/* ============================== Formatting ============================= */

function formatMoney(n) {
  return `$${n.toFixed(2)}`;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

function couponImageUrl(id) {
  const padded = String(id).padStart(11, '0');
  return `https://images.heb.com/is/image/HEBGrocery/cpn-large/coupon-${padded}.jpg`;
}

/* ============================== Rendering =============================== */

let selectedFeaturedId = null;
const checkedGeneralIds = new Set();

function loadPriceOverrides() {
  try {
    PRICE_OVERRIDES = JSON.parse(localStorage.getItem(PRICE_OVERRIDES_KEY) || '{}');
  } catch (e) {
    PRICE_OVERRIDES = {};
  }
}

function savePriceOverride(couponId, price) {
  if (price == null || Number.isNaN(price)) {
    delete PRICE_OVERRIDES[couponId];
  } else {
    PRICE_OVERRIDES[couponId] = price;
  }
  localStorage.setItem(PRICE_OVERRIDES_KEY, JSON.stringify(PRICE_OVERRIDES));
}

function loadItemNotes() {
  try {
    ITEM_NOTES = JSON.parse(localStorage.getItem(ITEM_NOTES_KEY) || '{}');
  } catch (e) {
    ITEM_NOTES = {};
  }
}

function saveItemNote(couponId, name, price) {
  const list = ITEM_NOTES[couponId] || (ITEM_NOTES[couponId] = []);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  list.push({ id, name, price, addedAt: new Date().toISOString() });
  localStorage.setItem(ITEM_NOTES_KEY, JSON.stringify(ITEM_NOTES));
  return id;
}

function removeItemNote(couponId, itemId) {
  ITEM_NOTES[couponId] = (ITEM_NOTES[couponId] || []).filter((i) => i.id !== itemId);
  localStorage.setItem(ITEM_NOTES_KEY, JSON.stringify(ITEM_NOTES));
}

function renderHero() {
  const heroAmount = document.getElementById('hero-amount');
  const heroSub = document.getElementById('hero-sub');
  const heroCta = document.getElementById('hero-cta');
  const best = computeHeroStack(DATA, PRICES);

  if (best) {
    heroAmount.textContent = formatMoney(best.totalSavings);
    heroSub.textContent = `Stack ${best.itemCount + 1} coupon${best.itemCount ? 's' : ''} on a ${formatMoney(best.subtotal)} basket right now.`;
    heroCta.textContent = 'Build this stack →';
    heroCta.onclick = (e) => {
      e.preventDefault();
      openStackBuilder(best.featured.id);
    };
  } else {
    heroAmount.textContent = '$?.??';
    heroSub.textContent = 'Add a few prices below and this fills in with your real savings.';
    heroCta.textContent = 'Browse featured coupons →';
    heroCta.onclick = (e) => {
      e.preventDefault();
      document.querySelector('.featured-grid')?.scrollIntoView({ behavior: 'smooth' });
    };
  }
}

function bestStackCardHTML(stack) {
  const { featured, percentBack, strongMatches } = stack;
  const matchLabel = strongMatches
    .slice(0, 2)
    .map((m) => escapeHTML(m.coupon.value || ''))
    .join(' + ');
  const extra = strongMatches.length > 2 ? ` + ${strongMatches.length - 2} more` : '';
  return `
    <div class="best-stack-card" data-featured-id="${escapeHTML(featured.id)}">
      <div class="best-stack-pct">${percentBack.toFixed(0)}% back</div>
      <div class="best-stack-value">${escapeHTML(featured.value || '')}</div>
      <div class="best-stack-desc">${escapeHTML(featured.description || '')}</div>
      <div class="best-stack-matches">✓ ${strongMatches.length} confirmed match${strongMatches.length > 1 ? 'es' : ''}: ${matchLabel}${extra}</div>
      <button type="button" class="build-stack-btn" data-featured-id="${escapeHTML(featured.id)}">Build this stack →</button>
    </div>`;
}

function renderBestStacks() {
  const container = document.getElementById('best-stacks-list');
  if (!container) return;

  const stacks = computeBestStacks(DATA, PRICES);
  container.innerHTML = stacks.length
    ? stacks.map(bestStackCardHTML).join('')
    : `<div class="empty-state">No confirmed stacks yet — check back after the next coupon refresh.</div>`;

  container.querySelectorAll('[data-featured-id]').forEach((el) => {
    el.addEventListener('click', () => openStackBuilder(el.dataset.featuredId));
  });
}

function cardHTML(c) {
  const isSelected = c.id === selectedFeaturedId;
  return `
    <div class="card selectable${isSelected ? ' selected' : ''}" data-featured-id="${escapeHTML(c.id)}">
      <img class="coupon-img" src="${couponImageUrl(c.id)}" alt="${escapeHTML(c.description || '')}" loading="lazy" onerror="this.style.display='none'">
      <div class="value">${escapeHTML(c.value || '')}</div>
      <div class="desc">${escapeHTML(c.description || '')}</div>
      <div class="meta">
        <span>${c.expires ? 'Expires ' + escapeHTML(c.expires) : ''}</span>
        <span>${escapeHTML(c.limit || '')}</span>
      </div>
      <button type="button" class="build-stack-btn" data-featured-id="${escapeHTML(c.id)}">
        ${isSelected ? '✓ Building this stack' : 'Build my stack →'}
      </button>
      <a class="clip" href="${c.url}" target="_blank" rel="noopener">View / Clip on heb.com →</a>
    </div>`;
}

function rowHTML(c, brandColorMap) {
  const highlighted = highlightBrands(c.description, brandColorMap);
  return `
    <div class="row">
      <span class="value">${escapeHTML(c.value || '')}</span>
      <span class="desc">${highlighted}</span>
      <span class="meta">${c.expires ? 'Exp ' + escapeHTML(c.expires) : ''} · ${escapeHTML(c.limit || '')}</span>
      <a class="clip" href="${c.url}" target="_blank" rel="noopener">Clip →</a>
    </div>`;
}

function highlightBrands(text, brandColorMap) {
  let result = escapeHTML(text);
  Object.keys(brandColorMap).forEach((brand) => {
    const re = new RegExp(`\\b(${escapeRegExp(escapeHTML(brand))})\\b`, 'i');
    if (re.test(result)) {
      result = result.replace(re, `<span class="brand-hit">$1</span>`);
    }
  });
  return result;
}

function matches(c, query) {
  if (!query) return true;
  const haystack = (c.value + ' ' + c.description).toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function itemChipHTML(coupon, item) {
  return `
    <button type="button" class="item-chip" data-use-price="${item.price}" data-coupon-id="${escapeHTML(coupon.id)}"
            title="Click to use this price">
      <span class="item-chip-name">${escapeHTML(item.name)}</span>
      <span class="item-chip-price">${formatMoney(item.price)}</span>
      ${item.source === 'manual'
        ? `<span class="item-chip-remove" data-remove-item="${escapeHTML(item.id)}" data-coupon-id="${escapeHTML(coupon.id)}" title="Remove">✕</span>`
        : `<span class="item-chip-source" title="From the price bookmarklet">🔍</span>`}
    </button>`;
}

function matchRowHTML(m) {
  const { coupon, tier, priceMatch, reasons } = m;
  const checked = checkedGeneralIds.has(coupon.id);
  const effectivePrice = getEffectivePrice(coupon, priceMatch);
  const badgeClass = effectivePrice != null ? 'price-verified' : tier;
  const badgeText = effectivePrice != null ? 'priced' : tier === 'strong' ? 'strong match' : 'verify at checkout';
  const items = itemsForCoupon(coupon, PRICES);

  return `
    <div class="match-row${checked ? ' checked' : ''}" data-coupon-id="${escapeHTML(coupon.id)}" title="${escapeHTML(reasons.join(' · '))}">
      <div class="match-row-top">
        <label class="match-checkbox-wrap">
          <input type="checkbox" data-coupon-id="${escapeHTML(coupon.id)}" ${checked ? 'checked' : ''}>
        </label>
        <img class="match-thumb" src="${couponImageUrl(coupon.id)}" alt="" loading="lazy" onerror="this.style.display='none'">
        <div class="match-row-info">
          <div class="match-row-line1">
            <span class="match-value">${escapeHTML(coupon.value || '')}</span>
            <span class="confidence-badge ${badgeClass}">${badgeText}</span>
            <a class="match-clip-link" href="${coupon.url}" target="_blank" rel="noopener">Clip on heb.com →</a>
          </div>
          <div class="match-desc">${escapeHTML(coupon.description || '')}</div>
        </div>
      </div>
      <div class="match-items">
        ${items.map((i) => itemChipHTML(coupon, i)).join('')}
        <button type="button" class="item-add-btn" data-coupon-id="${escapeHTML(coupon.id)}">+ Add item you found</button>
        <span class="price-input-wrap">$
          <input type="number" step="0.01" min="0" placeholder="price" data-price-for="${escapeHTML(coupon.id)}"
                 value="${Object.prototype.hasOwnProperty.call(PRICE_OVERRIDES, coupon.id) ? PRICE_OVERRIDES[coupon.id] : ''}">
        </span>
      </div>
      <div class="item-add-form" data-coupon-id="${escapeHTML(coupon.id)}" hidden>
        <input type="text" class="item-add-name" placeholder="Item name, e.g. Dove Body Wash 22 oz.">
        <input type="number" step="0.01" min="0" class="item-add-price" placeholder="Price">
        <button type="button" class="item-add-save" data-coupon-id="${escapeHTML(coupon.id)}">Save</button>
        <button type="button" class="item-add-cancel">Cancel</button>
      </div>
    </div>`;
}

function renderStackBuilder() {
  const container = document.getElementById('stack-builder');
  if (!selectedFeaturedId) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  const featured = (DATA.featured_stackable_candidates || []).find((c) => c.id === selectedFeaturedId);
  if (!featured) {
    container.style.display = 'none';
    return;
  }

  const allMatches = buildMatches(featured, DATA.general_coupons || [], PRICES);
  const strongMatches = allMatches.filter((m) => m.tier === 'strong');
  const possibleMatches = allMatches.filter((m) => m.tier === 'possible');

  container.style.display = 'block';
  container.innerHTML = `
    <div class="stack-builder-header">
      <div>
        <h2>🧮 Stacking with: ${escapeHTML(featured.value)} — ${escapeHTML(featured.description)}</h2>
        <p>Check the coupons you'll also use. A coupon can cover several products — "+ Add item you found" logs one after you check heb.com once, and it's remembered for next time.</p>
      </div>
      <button type="button" class="stack-builder-close" id="stack-builder-close" aria-label="Close">✕</button>
    </div>
    ${strongMatches.length ? `
      <div class="tier-group">
        <h3><span class="tier-dot strong"></span>Strong matches (${strongMatches.length})</h3>
        ${strongMatches.map(matchRowHTML).join('')}
      </div>` : ''}
    ${possibleMatches.length ? `
      <div class="tier-group">
        <h3><span class="tier-dot possible"></span>Possible — verify at checkout (${possibleMatches.length})</h3>
        ${possibleMatches.map(matchRowHTML).join('')}
      </div>` : ''}
    ${!strongMatches.length && !possibleMatches.length ? `<div class="empty-state">No obviously matching coupons found for this basket coupon yet.</div>` : ''}
    <div class="stack-summary" id="stack-summary"></div>
  `;

  document.getElementById('stack-builder-close').addEventListener('click', () => {
    selectedFeaturedId = null;
    render();
  });

  container.querySelectorAll('input[type="checkbox"][data-coupon-id]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.couponId;
      if (cb.checked) checkedGeneralIds.add(id);
      else checkedGeneralIds.delete(id);
      renderStackBuilder();
    });
  });

  container.querySelectorAll('input[type="number"][data-price-for]').forEach((input) => {
    input.addEventListener('input', () => {
      const id = input.dataset.priceFor;
      const val = input.value === '' ? null : parseFloat(input.value);
      savePriceOverride(id, val);
      recomputeSummary(featured, allMatches);
      renderHero();
    });
  });

  container.querySelectorAll('.item-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.couponId;
      const price = parseFloat(chip.dataset.usePrice);
      savePriceOverride(id, price);
      renderStackBuilder();
      renderHero();
    });
  });

  container.querySelectorAll('.item-chip-remove').forEach((removeBtn) => {
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also trigger the parent chip's "use this price" click
      removeItemNote(removeBtn.dataset.couponId, removeBtn.dataset.removeItem);
      renderStackBuilder();
    });
  });

  container.querySelectorAll('.item-add-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const form = container.querySelector(`.item-add-form[data-coupon-id="${btn.dataset.couponId}"]`);
      if (form) {
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector('.item-add-name').focus();
      }
    });
  });

  container.querySelectorAll('.item-add-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.closest('.item-add-form').hidden = true;
    });
  });

  container.querySelectorAll('.item-add-save').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.couponId;
      const form = btn.closest('.item-add-form');
      const name = form.querySelector('.item-add-name').value.trim();
      const price = parseFloat(form.querySelector('.item-add-price').value);
      if (!name || Number.isNaN(price)) return;
      saveItemNote(id, name, price);
      savePriceOverride(id, price); // use it right away, no extra click needed
      renderStackBuilder();
      renderHero();
    });
  });

  recomputeSummary(featured, allMatches);
}

function recomputeSummary(featured, allMatches) {
  const summaryEl = document.getElementById('stack-summary');
  if (!summaryEl) return;

  const threshold = parseBasketThreshold(featured);
  const checked = allMatches.filter((m) => checkedGeneralIds.has(m.coupon.id));

  let subtotal = 0;
  let generalSavings = 0;
  let unpriced = 0;
  for (const m of checked) {
    const price = getEffectivePrice(m.coupon, m.priceMatch);
    if (price == null) {
      unpriced++;
      continue;
    }
    subtotal += price;
    const sav = parseCouponSavings(m.coupon, price);
    if (sav.computable) generalSavings += sav.amount;
  }

  const basketApplies = threshold && subtotal >= threshold.threshold;
  const totalSavings = generalSavings + (basketApplies ? threshold.discount : 0);
  const finalPrice = Math.max(0, subtotal - totalSavings);
  const percent = subtotal > 0 ? (totalSavings / subtotal) * 100 : 0;

  const thresholdNote = threshold
    ? basketApplies
      ? `✅ ${formatMoney(threshold.discount)} basket coupon unlocked`
      : `Add ${formatMoney(Math.max(0, threshold.threshold - subtotal))} more to unlock the ${formatMoney(threshold.discount)} basket coupon`
    : '';

  summaryEl.innerHTML = `
    <div class="metric"><div class="num">${formatMoney(subtotal)}</div><div class="label">Subtotal</div></div>
    <div class="metric savings"><div class="num">${formatMoney(totalSavings)}</div><div class="label">Total savings</div></div>
    <div class="metric"><div class="num">${formatMoney(finalPrice)}</div><div class="label">You pay</div></div>
    <div class="metric"><div class="num">${percent.toFixed(0)}%</div><div class="label">Off</div></div>
    <div class="metric note" style="opacity:0.85;">
      ${thresholdNote}${unpriced ? ` · ${unpriced} item${unpriced > 1 ? 's' : ''} need a price entered above to count toward the total` : ''}
    </div>
  `;
}

function openStackBuilder(featuredId) {
  if (featuredId !== selectedFeaturedId) {
    checkedGeneralIds.clear();
  }
  selectedFeaturedId = featuredId;
  render();
  document.getElementById('stack-builder')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render() {
  const query = document.getElementById('search').value.trim();
  const filter = document.getElementById('filter-select').value;

  const featuredGrid = document.getElementById('featured-grid');
  const generalList = document.getElementById('general-list');

  const showFeatured = filter === 'all' || filter === 'featured';
  const showGeneral = filter === 'all' || filter === 'general';

  const featured = showFeatured
    ? (DATA.featured_stackable_candidates || []).filter((c) => matches(c, query))
    : [];
  const general = showGeneral
    ? (DATA.general_coupons || []).filter((c) => matches(c, query))
    : [];

  // Brand highlighting in the general list uses the union of every featured
  // coupon's qualifying items + dictionary brands, so browsing the list
  // still gives a quick visual sense of what's potentially stackable.
  const brandColorMap = {};
  (DATA.featured_stackable_candidates || []).forEach((c) => {
    extractQualifyingItems(c.description).forEach((p) => {
      if (!isGenericPhrase(p)) brandColorMap[p] = true;
    });
    findBrandsInText(c.description).forEach((b) => {
      brandColorMap[b] = true;
    });
  });

  featuredGrid.innerHTML = featured.length
    ? featured.map(cardHTML).join('')
    : `<div class="empty-state">No featured basket coupons match.</div>`;

  featuredGrid.querySelectorAll('[data-featured-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('a.clip')) return; // let the outbound link work normally
      openStackBuilder(el.dataset.featuredId);
    });
  });

  generalList.innerHTML = general.length
    ? general.map((c) => rowHTML(c, brandColorMap)).join('')
    : `<div class="empty-state">No coupons match.</div>`;

  document.querySelector('section.featured').style.display = showFeatured ? '' : 'none';
  document.querySelector('main > section.all-others').style.display = showGeneral ? '' : 'none';

  renderBestStacks();
  renderStackBuilder();
  renderHero();
}

function applyStaleBanner() {
  const banner = document.getElementById('stale-banner');
  const status = DATA.last_scrape_status;
  const bookmarkletHref = 'tools/bookmarklet/README.md';

  const messages = {
    failed: () =>
      `⚠️ This week's automated scrape was blocked — showing the last known-good data ` +
      `(from ${DATA.updated_at ? new Date(DATA.updated_at).toLocaleDateString() : 'unknown'}). ` +
      `<a href="${bookmarkletHref}">Run the bookmarklet to refresh now →</a>`,
    partial_manual: () =>
      `ℹ️ This data was captured manually while H-E-B's site was blocking automated scraping. ` +
      `<a href="${bookmarkletHref}">Run the bookmarklet for a full automatic refresh →</a>`,
  };
  // Note: a "success" status covers both scrape sources (bookmarklet or the
  // opportunistic Actions run) — see the `source` field in the footer for
  // which one produced the current data. Only failed/partial states get a
  // banner; a successful run from either source needs no extra flagging.

  if (messages[status]) {
    banner.className = `stale-banner status-${status}`;
    banner.style.display = 'block';
    banner.innerHTML = messages[status]();
  } else {
    banner.style.display = 'none';
  }
}

async function load() {
  loadPriceOverrides();
  loadItemNotes();
  try {
    const [couponsRes, pricesRes] = await Promise.all([
      fetch('coupons.json', { cache: 'no-store' }),
      fetch('prices.json', { cache: 'no-store' }).catch(() => null),
    ]);
    DATA = await couponsRes.json();
    PRICES = pricesRes && pricesRes.ok ? await pricesRes.json() : { products: {} };

    applyStaleBanner();

    document.getElementById('header-sub').textContent =
      `${DATA.total_coupons ?? ((DATA.featured_stackable_candidates || []).length + (DATA.general_coupons || []).length)} coupons · Auto-updated weekly from heb.com`;
    const updated = DATA.updated_at ? new Date(DATA.updated_at) : null;
    const sourceLabel = { bookmarklet: 'via bookmarklet', 'github-actions-playwright': 'via automated scrape' }[DATA.source];
    document.getElementById('updated-footer').textContent = updated
      ? `Last updated ${updated.toLocaleString()}${sourceLabel ? ' ' + sourceLabel : ''} · Source: heb.com/digital-coupon`
      : '';
  } catch (e) {
    document.getElementById('featured-grid').innerHTML =
      `<div class="empty-state">Could not load coupons.json yet — run the scraper or bookmarklet first.</div>`;
  }
  render();
}

document.getElementById('search').addEventListener('input', render);
document.getElementById('filter-select').addEventListener('change', render);

load();
