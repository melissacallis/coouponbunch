/**
 * Walgreens Deals — weekly-ad + manufacturer-coupon + Cash-rewards stack
 * finder.
 *
 * Weekly Ad items are the base list (each one is already a deal on its
 * own). A weekly-ad item only makes the list here if it ALSO has at least
 * one stackable signal on top — plain sale items with nothing to stack are
 * left out, same "only show what's actually worth combining" philosophy as
 * the Target Deals page. Four signals count:
 *   - a matching manufacturer coupon (brand match against walgreens_coupons.json)
 *   - a matching Walgreens Cash rewards offer (brand match against walgreens_cashrewards.json)
 *   - an embedded coupon printed right on the weekly-ad tile itself
 *     (item.embedded_coupon_value) — more reliable than brand-matching
 *     since it's already tied to this exact item
 *   - an in-store myWalgreens rewards line printed on the tile
 *     (item.in_store_reward_amount) — a different loyalty program from the
 *     online "W Cash" rewards, tracked separately
 */

let WEEKLY_AD = { items: [] };
let COUPONS = { coupons: [] };
let CASH_REWARDS = { offers: [] };

function formatMoney(n) {
  return `$${n.toFixed(2)}`;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

// Prefix match (one brand's words start with the other's), not raw
// substring containment — "Bounty" (paper towels) vs "Nature's Bounty"
// (vitamins) share the word "Bounty" but aren't the same brand, and plain
// .includes() would wrongly match them (confirmed with real Walgreens data:
// "Blue" from "Blue Diamond Almonds" also falsely matched "Clearblue
// Ovulation Tests" this way). Requiring a shared leading word/phrase avoids
// both false positives while still matching "Tide" against "Tide Liquid
// Laundry Detergent".
function brandsMatch(a, b) {
  if (!a || !b) return false;
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  return na.startsWith(nb + ' ') || nb.startsWith(na + ' ');
}

// Flat-dollar or percent-off coupons have a computable savings amount;
// anything else (e.g. a BOGO phrasing with no flat number) is left out of
// the total rather than guessed at.
function parseCouponValue(value, price) {
  let m = (value || '').match(/\$(\d+(?:\.\d{2})?)\s+off/i);
  if (m) return { amount: parseFloat(m[1]), computable: true };
  m = (value || '').match(/(\d+)%\s+off/i);
  if (m && price != null) return { amount: price * (parseInt(m[1], 10) / 100), computable: true };
  return { amount: 0, computable: false };
}

function cashRewardLabel(offer) {
  if (offer.offer_type === 'qty' && offer.qty != null) {
    return `Buy ${offer.qty}, get ${formatMoney(offer.amount)} Walgreens Cash`;
  }
  if (offer.offer_type === 'spend' && offer.threshold != null) {
    return `Spend ${formatMoney(offer.threshold)}, get ${formatMoney(offer.amount)} Walgreens Cash`;
  }
  return `Get ${formatMoney(offer.amount)} Walgreens Cash`;
}

// Only weekly-ad items with at least one stackable signal make the list,
// ranked by total combined savings.
function buildStacks(weeklyAd, coupons, cashRewards) {
  const stacks = [];
  for (const item of weeklyAd) {
    const coupon = coupons.find((c) => brandsMatch(c.brand, item.brand));
    const cashReward = cashRewards.find((r) => brandsMatch(r.brand, item.brand));
    const hasEmbeddedCoupon = !!item.embedded_coupon_value;
    const hasInStoreReward = item.in_store_reward_amount != null;
    if (!coupon && !cashReward && !hasEmbeddedCoupon && !hasInStoreReward) continue;

    const couponSavings = coupon ? parseCouponValue(coupon.value, item.sale_price) : { amount: 0, computable: true };
    const embeddedCouponSavings = hasEmbeddedCoupon
      ? parseCouponValue(item.embedded_coupon_value, item.sale_price)
      : { amount: 0, computable: true };
    const cashRewardAmount = cashReward ? cashReward.amount : 0;
    const inStoreRewardAmount = hasInStoreReward ? item.in_store_reward_amount : 0;
    const anyUncomputable = (coupon && !couponSavings.computable) || (hasEmbeddedCoupon && !embeddedCouponSavings.computable);
    const totalSavings =
      (couponSavings.computable ? couponSavings.amount : 0) +
      (embeddedCouponSavings.computable ? embeddedCouponSavings.amount : 0) +
      cashRewardAmount +
      inStoreRewardAmount;
    const finalPrice = Math.max(0, item.sale_price - totalSavings);

    stacks.push({
      item, coupon, cashReward, couponSavings, embeddedCouponSavings,
      cashRewardAmount, inStoreRewardAmount, totalSavings, finalPrice, anyUncomputable,
    });
  }
  stacks.sort((a, b) => b.totalSavings - a.totalSavings);
  return stacks;
}

function stackCardHTML(stack) {
  const { item, coupon, cashReward, couponSavings, cashRewardAmount, inStoreRewardAmount, totalSavings, finalPrice, anyUncomputable } = stack;
  return `
    <div class="w-card">
      <img class="w-card-img" src="${item.image ? escapeHTML(item.image) : ''}" alt="" loading="lazy"
           onerror="this.style.display='none'" ${item.image ? '' : 'style="display:none"'}>
      <div class="w-card-body">
        <div class="w-card-name">${escapeHTML(item.name)}</div>
        <div class="w-card-price">
          ${formatMoney(item.sale_price)}
          ${item.regular_price ? `<span class="w-card-regular">${formatMoney(item.regular_price)}</span>` : ''}
        </div>
        ${coupon ? `<div class="w-badge w-badge-coupon">🏷️ ${escapeHTML(coupon.value)} — ${escapeHTML(coupon.description)}</div>` : ''}
        ${item.embedded_coupon_value ? `<div class="w-badge w-badge-coupon">🏷️ ${escapeHTML(item.embedded_coupon_value)} on this item — ${escapeHTML(item.embedded_coupon_text || '')}</div>` : ''}
        ${cashReward ? `<div class="w-badge w-badge-cashback">💵 ${escapeHTML(cashRewardLabel(cashReward))}</div>` : ''}
        ${inStoreRewardAmount ? `<div class="w-badge w-badge-cashback">🏬 Earn ${formatMoney(inStoreRewardAmount)} in-store rewards${item.in_store_reward_qty ? ` when you buy ${item.in_store_reward_qty}` : ''}</div>` : ''}
        ${anyUncomputable ? `<div class="w-note">Coupon savings not shown (not a flat $/% off) — check walgreens.com for the exact amount.</div>` : ''}
        <div class="w-savings">
          Save ${formatMoney(totalSavings)}${anyUncomputable ? '+' : ''} · Final price ~${formatMoney(finalPrice)}
        </div>
        <div class="w-links">
          <a href="${item.url}" target="_blank" rel="noopener">View item →</a>
          ${coupon ? `<a href="${coupon.url}" target="_blank" rel="noopener">Clip coupon →</a>` : ''}
          ${cashReward ? `<a href="${cashReward.url}" target="_blank" rel="noopener">View Cash reward →</a>` : ''}
        </div>
      </div>
    </div>`;
}

function renderHero(stacks) {
  const amountEl = document.getElementById('w-hero-amount');
  const subEl = document.getElementById('w-hero-sub');
  if (stacks.length) {
    const best = stacks[0];
    amountEl.textContent = `${formatMoney(best.totalSavings)}${best.anyUncomputable ? '+' : ''}`;
    subEl.textContent = `Best stack right now: ${best.item.name}`;
  } else {
    amountEl.textContent = '$?.??';
    subEl.textContent = 'No weekly-ad + coupon/Cash-rewards stacks found yet — run the Walgreens bookmarklets to pull in current deals.';
  }
}

function render() {
  const stacks = buildStacks(WEEKLY_AD.items || [], COUPONS.coupons || [], CASH_REWARDS.offers || []);
  renderHero(stacks);

  const list = document.getElementById('w-stack-list');
  const countEl = document.getElementById('w-count');
  countEl.textContent = `${stacks.length} stackable deal${stacks.length === 1 ? '' : 's'} found`;

  list.innerHTML = stacks.length
    ? stacks.map(stackCardHTML).join('')
    : `<div class="empty-state">No weekly-ad items currently have a matching coupon or Cash reward. Run the bookmarklets (see tools/bookmarklet/README.md) to pull in fresh data.</div>`;
}

async function load() {
  try {
    const [weeklyAdRes, couponsRes, cashRewardsRes] = await Promise.all([
      fetch('../walgreens_weeklyad.json', { cache: 'no-store' }),
      fetch('../walgreens_coupons.json', { cache: 'no-store' }),
      fetch('../walgreens_cashrewards.json', { cache: 'no-store' }),
    ]);
    WEEKLY_AD = await weeklyAdRes.json();
    COUPONS = await couponsRes.json();
    CASH_REWARDS = await cashRewardsRes.json();

    const updated = WEEKLY_AD.updated_at ? new Date(WEEKLY_AD.updated_at) : null;
    document.getElementById('w-updated-footer').textContent = updated
      ? `Last updated ${updated.toLocaleString()} · Source: walgreens.com`
      : 'No data yet — run the bookmarklets to pull in current Walgreens deals.';
  } catch (e) {
    document.getElementById('w-stack-list').innerHTML =
      `<div class="empty-state">Could not load Walgreens data yet — run the bookmarklets first (see tools/bookmarklet/README.md).</div>`;
  }
  render();
}

load();
