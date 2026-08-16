/**
 * Target Deals — gift-card + manufacturer-coupon stack finder.
 *
 * Different mechanic than the H-E-B side of this site: instead of ranking
 * every possible pairing by confidence, this only ever shows a product if
 * it has BOTH a "buy X / spend $Y, get a $Z Target GiftCard" promo AND a
 * matching Circle/manufacturer coupon — a strict filter, not a ranked list.
 */

let PRODUCTS = { products: [] };
let COUPONS = { coupons: [] };

function formatMoney(n) {
  return `$${n.toFixed(2)}`;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

// Real target.com phrasing (verified against a live product-listing page,
// 2026-08) reads "$X Target GiftCard with ..." — the amount comes FIRST,
// which is the reverse of what was originally assumed here ("Spend $X, Get
// a $Y Target GiftCard"). Two variants seen on real product cards:
//   "$15 Target GiftCard with $50 household items purchase" -> spend $50, get $15
//   "$5 Target GiftCard with 3 oral care items"              -> buy 3 items, get $5
// The older "Buy X, Get a $Y" / "Spend $X, Get a $Y" phrasings are kept as
// fallbacks in case Target uses them on other pages (e.g. Circle offers).
function parseGiftCardPromo(text) {
  if (!text) return null;
  let m = text.match(/\$(\d+(?:\.\d{2})?)\s+target\s+gift\s?card\s+with\s+\$(\d+(?:\.\d{2})?)\s+[\w\s]*?purchase/i);
  if (m) return { type: 'spend', threshold: parseFloat(m[2]), value: parseFloat(m[1]) };
  m = text.match(/\$(\d+(?:\.\d{2})?)\s+target\s+gift\s?card\s+with\s+(\d+)\s+[\w\s]*?items?/i);
  if (m) return { type: 'qty', qty: parseInt(m[2], 10), value: parseFloat(m[1]) };
  m = text.match(/buy\s+(\d+),?\s+get\s+a?\s*\$(\d+(?:\.\d{2})?)\s+target\s+gift\s?card/i);
  if (m) return { type: 'qty', qty: parseInt(m[1], 10), value: parseFloat(m[2]) };
  m = text.match(/spend\s+\$(\d+(?:\.\d{2})?),?\s+get\s+a?\s*\$(\d+(?:\.\d{2})?)\s+target\s+gift\s?card/i);
  if (m) return { type: 'spend', threshold: parseFloat(m[1]), value: parseFloat(m[2]) };
  return null;
}

function giftCardLabel(giftCard) {
  return giftCard.type === 'qty'
    ? `Buy ${giftCard.qty}, get a ${formatMoney(giftCard.value)} Target GiftCard`
    : `Spend ${formatMoney(giftCard.threshold)}, get a ${formatMoney(giftCard.value)} Target GiftCard`;
}

// Flat-dollar or percent-off coupons have a computable savings amount;
// anything else (e.g. "20% off select sizes") without enough info is left
// out of the total rather than guessed at.
function parseCouponValue(value, price) {
  let m = (value || '').match(/\$(\d+(?:\.\d{2})?)\s+off/i);
  if (m) return { amount: parseFloat(m[1]), computable: true };
  m = (value || '').match(/(\d+)%\s+off/i);
  if (m && price != null) return { amount: price * (parseInt(m[1], 10) / 100), computable: true };
  return { amount: 0, computable: false };
}

function brandsMatch(a, b) {
  if (!a || !b) return false;
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Only pairs where a product has BOTH a gift-card promo AND a matching
// manufacturer/Circle coupon make the list — this is a filter, not a
// ranked "maybe" list like the H-E-B side of the site.
function buildStacks(products, coupons) {
  const stacks = [];
  for (const product of products) {
    const giftCard = parseGiftCardPromo(product.gift_card_promo);
    if (!giftCard) continue;
    const coupon = coupons.find((c) => brandsMatch(c.brand, product.brand));
    if (!coupon) continue;
    const couponSavings = parseCouponValue(coupon.value, product.price);
    const totalSavings = giftCard.value + (couponSavings.computable ? couponSavings.amount : 0);
    stacks.push({ product, giftCard, coupon, couponSavings, totalSavings });
  }
  stacks.sort((a, b) => b.totalSavings - a.totalSavings);
  return stacks;
}

function stackCardHTML(stack) {
  const { product, giftCard, coupon, couponSavings, totalSavings } = stack;
  return `
    <div class="t-card">
      <img class="t-card-img" src="${product.image ? escapeHTML(product.image) : ''}" alt="" loading="lazy"
           onerror="this.style.display='none'" ${product.image ? '' : 'style="display:none"'}>
      <div class="t-card-body">
        <div class="t-card-name">${escapeHTML(product.name)}</div>
        <div class="t-card-price">${formatMoney(product.price)}</div>
        <div class="t-badge t-badge-giftcard">🎁 ${escapeHTML(giftCardLabel(giftCard))}</div>
        <div class="t-badge t-badge-coupon">🏷️ ${escapeHTML(coupon.description)}</div>
        ${!couponSavings.computable ? `<div class="t-note">Coupon savings not shown (not a flat $/% off) — check target.com for the exact amount.</div>` : ''}
        <div class="t-savings">Stack value: ${formatMoney(totalSavings)}${!couponSavings.computable ? '+' : ''}</div>
        <div class="t-links">
          <a href="${product.url}" target="_blank" rel="noopener">View product →</a>
          <a href="${coupon.url}" target="_blank" rel="noopener">Activate coupon →</a>
        </div>
      </div>
    </div>`;
}

function renderHero(stacks) {
  const amountEl = document.getElementById('t-hero-amount');
  const subEl = document.getElementById('t-hero-sub');
  if (stacks.length) {
    const best = stacks[0];
    amountEl.textContent = `${formatMoney(best.totalSavings)}${!best.couponSavings.computable ? '+' : ''}`;
    subEl.textContent = `Best stack right now: ${best.product.name}`;
  } else {
    amountEl.textContent = '$?.??';
    subEl.textContent = 'No gift-card + coupon stacks found yet — run the Target bookmarklets to pull in current deals.';
  }
}

function render() {
  const stacks = buildStacks(PRODUCTS.products || [], COUPONS.coupons || []);
  renderHero(stacks);

  const list = document.getElementById('t-stack-list');
  const countEl = document.getElementById('t-count');
  countEl.textContent = `${stacks.length} stackable deal${stacks.length === 1 ? '' : 's'} found`;

  list.innerHTML = stacks.length
    ? stacks.map(stackCardHTML).join('')
    : `<div class="empty-state">No products currently have both a gift-card promo and a matching coupon. Run the bookmarklets (see tools/bookmarklet/README.md) to pull in fresh data.</div>`;
}

async function load() {
  try {
    const [productsRes, couponsRes] = await Promise.all([
      fetch('../target_products.json', { cache: 'no-store' }),
      fetch('../target_coupons.json', { cache: 'no-store' }),
    ]);
    PRODUCTS = await productsRes.json();
    COUPONS = await couponsRes.json();

    const updated = PRODUCTS.updated_at ? new Date(PRODUCTS.updated_at) : null;
    document.getElementById('t-updated-footer').textContent = updated
      ? `Last updated ${updated.toLocaleString()} · Source: target.com`
      : 'No data yet — run the bookmarklets to pull in current Target deals.';
  } catch (e) {
    document.getElementById('t-stack-list').innerHTML =
      `<div class="empty-state">Could not load Target data yet — run the bookmarklets first (see tools/bookmarklet/README.md).</div>`;
  }
  render();
}

load();
