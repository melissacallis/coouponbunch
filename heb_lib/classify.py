"""Coupon classification: featured (basket-threshold) vs. general, plus
qualifying-brand extraction used by the stacking/confidence engine.

Keep this file's logic mirrored in assets/app.js's JS equivalents
(parseQualifyingItems, isStackableCandidate) — the two must produce the same
answers since one runs at scrape/import time and the other runs live in the
browser.
"""

import re

# Matches things like "$5 off your basket when you buy $25 of ..."
BASKET_PATTERN = re.compile(
    r"\$\d+(\.\d{2})?\s+off\s+your\s+basket\s+when\s+you\s+buy\s+\$\d+", re.I
)
# Fallback: the little value chip on the card, e.g. "$5 off $25 (select items)"
VALUE_CHIP_BASKET_PATTERN = re.compile(r"\$\d+(\.\d{2})?\s+off\s+\$\d+", re.I)

# Pulls the qualifying-brand/category clause out of a basket coupon's
# description, e.g. "...buy $25 of Dove, AXE, or Schmidt's items" ->
# "Dove, AXE, or Schmidt's"
QUALIFYING_CLAUSE_PATTERN = re.compile(
    r"buy\s+\$\d+(?:\.\d{2})?\s+of\s+(.+?)(?:\s+items?\b|\s+products?\b|\s*\(|$)",
    re.I,
)

_SPLIT_PATTERN = re.compile(r",|\bor\b|\band\b", re.I)

# A poorly-terminated qualifying clause (one that doesn't cleanly end at
# "items"/"products"/"(") can spill into a trailing size/count descriptor,
# e.g. "...buy $25 of Dove, AXE, 20 oz." splitting out "20 oz." as if it
# were a brand name. That's a near-content-free fragment that can
# spuriously substring-match unrelated coupons, so it's filtered out rather
# than treated as a real qualifying phrase. Mirrors assets/app.js.
_SIZE_FRAGMENT_PATTERN = re.compile(
    r"^\d+(\.\d+)?\s*-?\s*\d*(\.\d+)?\s*(oz\.?|ct\.?|lb\.?|fl\.?\s*oz\.?|pk\.?|count|ea\.?|each|g|ml|qt\.?)\.?$",
    re.I,
)
# Trailing filler like "assorted varieties" carries no brand/category signal
# at all — it shows up in nearly every coupon's description, so treating it
# as a qualifying phrase turns it into a false "strong" match against
# hundreds of unrelated coupons (confirmed against real data: 457).
_NOISE_PHRASE_PATTERN = re.compile(
    r"^(assorted|various|select)?\s*(varieties|flavors|sizes|selections?)$", re.I
)


def _is_size_fragment(phrase):
    return (
        bool(_SIZE_FRAGMENT_PATTERN.match(phrase))
        or bool(_NOISE_PHRASE_PATTERN.match(phrase))
        or len(re.sub(r"[^A-Za-z]", "", phrase)) < 3
    )


def is_stackable_candidate(coupon):
    """A coupon is a 'featured' basket-threshold candidate if its value or
    description reads like '$X off your basket when you buy $Y of ...'.

    Checks value and description independently rather than concatenated —
    concatenating them (e.g. value "$1 off" + description "$1 off H-E-B...")
    can accidentally form a "$1 off $1" adjacency that spuriously matches
    the basket-chip pattern even though neither field alone does.
    """
    for text in (coupon.get("value", ""), coupon.get("description", "")):
        if BASKET_PATTERN.search(text) or VALUE_CHIP_BASKET_PATTERN.search(text):
            return True
    return False


def extract_qualifying_items(description):
    """Extract the list of qualifying brand/category phrases from a featured
    coupon's description. Returns a list of trimmed phrase strings, e.g.
    "$5 off your basket when you buy $25 of Dove, AXE, or Schmidt's items"
    -> ["Dove", "AXE", "Schmidt's"].

    This is the *authoritative* per-coupon qualifying list — unlike a fixed
    brand dictionary, it self-updates every week with whatever H-E-B actually
    wrote in the coupon, with no manual maintenance.
    """
    m = QUALIFYING_CLAUSE_PATTERN.search(description or "")
    if not m:
        return []
    phrases = _SPLIT_PATTERN.split(m.group(1))
    return [p.strip() for p in phrases if len(p.strip()) > 1 and not _is_size_fragment(p.strip())]
