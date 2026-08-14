"""Shared coupon classification and I/O logic.

Used by both scrape_coupons.py (opportunistic Playwright scrape, run in
GitHub Actions) and tools/import_coupons.py (bookmarklet-driven import, the
primary/reliable path) so the two paths can't drift apart.
"""
