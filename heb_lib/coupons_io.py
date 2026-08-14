"""Load/save coupons.json with the failure-resilience pattern: never blank
the site out. A bad or partial run marks the file as stale/failed instead of
overwriting good data with worse data.
"""

import json
from datetime import datetime, timezone

from .classify import is_stackable_candidate

MIN_COUPON_RATIO = 0.5  # refuse to overwrite if new total < half the previous total


def load_existing(path="coupons.json"):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def is_partial_scrape(new_count, existing):
    """True if new_count looks like a partial/broken scrape relative to the
    last known-good total. With no prior data, only a very low absolute
    count (<20) is treated as suspicious."""
    if existing is None:
        return new_count < 20
    previous_total = existing.get("total_coupons", 0)
    if previous_total == 0:
        return new_count < 20
    return new_count < MIN_COUPON_RATIO * previous_total


def summarize_diff(existing, new_coupons):
    """Return {added, removed, changed, unchanged} counts comparing the
    previous coupons.json contents to a fresh list of coupon dicts."""
    old_coupons = []
    if existing:
        old_coupons = existing.get("featured_stackable_candidates", []) + existing.get(
            "general_coupons", []
        )
    old_by_id = {c["id"]: c for c in old_coupons}
    new_by_id = {c["id"]: c for c in new_coupons}

    added = [cid for cid in new_by_id if cid not in old_by_id]
    removed = [cid for cid in old_by_id if cid not in new_by_id]
    changed = [
        cid
        for cid in new_by_id
        if cid in old_by_id and new_by_id[cid] != old_by_id[cid]
    ]
    unchanged_count = len(new_by_id) - len(added) - len(changed)

    return {
        "added": len(added),
        "removed": len(removed),
        "changed": len(changed),
        "unchanged": unchanged_count,
    }


def build_output(coupons, source_url, source, status="success"):
    featured, general = [], []
    for c in coupons:
        (featured if is_stackable_candidate(c) else general).append(c)

    return {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source_url": source_url,
        "source": source,
        "total_coupons": len(coupons),
        "last_scrape_status": status,
        "featured_stackable_candidates": featured,
        "general_coupons": general,
    }


def write_success(coupons, source_url, source, path="coupons.json"):
    output = build_output(coupons, source_url, source, status="success")
    with open(path, "w") as f:
        json.dump(output, f, indent=2)
    return output


def write_failure(existing, error, path="coupons.json"):
    """Leave the last known-good coupons.json in place (don't touch the
    coupon lists), but record that this run failed so the site can flag it
    and stakeholders know the data is stale rather than wrong."""
    if existing is None:
        return None
    existing["last_scrape_status"] = "failed"
    existing["last_scrape_error"] = str(error)
    existing["last_scrape_attempted_at"] = datetime.now(timezone.utc).isoformat()
    with open(path, "w") as f:
        json.dump(existing, f, indent=2)
    return existing
