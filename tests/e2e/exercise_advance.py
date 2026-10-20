"""
E2E for the finish-exercise fix.

Finishing an exercise moves to the next UNFINISHED one and scrolls it into view.
Before, the right card was opened but could be over a thousand pixels off
screen, so it looked like nothing had happened and the exercise you had just
finished was still what you were looking at.
"""
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ORIGIN, ignorable, install_routes, missing_outputs  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "shots"
errors, results = [], []

absent = missing_outputs()
if absent:
    sys.exit("Missing build output: %s -- run `node build.mjs` first." % ", ".join(absent))

def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)


def log_open_sets(page):
    """Log every set of the currently open exercise with one tap each."""
    for _ in range(8):
        btn = page.locator(".editor button.btn.primary.big")
        if btn.count() == 0 or btn.first.inner_text().strip().startswith("Update"):
            return
        btn.first.click()
        page.wait_for_timeout(250)


def open_card(page):
    """(name, element) of the expanded exercise card, or (None, None)."""
    for card in page.locator(".ex-card").all():
        head = card.locator(".ex-head")
        if head.get_attribute("aria-expanded") == "true":
            return card.locator(".name").inner_text(), head
    return None, None


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and not ignorable(m.text) else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    install_routes(page)
    page.goto(ORIGIN + "/")
    expect(page.get_by_role("heading", name=re.compile("Today"))).to_be_visible(timeout=20000)

    page.get_by_role("button", name="Train").click()
    page.get_by_role("button", name=re.compile("Start Lower B")).click()
    expect(page.get_by_text("Leg Press").first).to_be_visible()

    # Pad the list out so a wrap-around lands well off screen, as in a real session.
    for _ in range(4):
        page.get_by_role("button", name=re.compile("Add exercise")).first.click()
        page.wait_for_timeout(250)
        page.locator("[role=dialog] .list-item, .sheet .list-item").first.click()
        page.wait_for_timeout(350)
    total = page.locator(".ex-card").count()
    check(f"workout has a long exercise list ({total} cards)", total >= 8)

    # Do the FIRST exercise, then jump to the LAST one, leaving the middle pending.
    # (Adding an exercise opens it, so open the first one again explicitly.)
    first_head = page.locator(".ex-head").first
    first_name = first_head.locator(".name").inner_text()
    first_head.click()
    page.wait_for_timeout(300)
    check(f"opened the first exercise ({first_name})", open_card(page)[0] == first_name)
    log_open_sets(page)
    last_head = page.locator(".ex-head").last
    last_name = last_head.locator(".name").inner_text()
    last_head.click()
    page.wait_for_timeout(300)
    log_open_sets(page)
    check(f"jumped ahead and finished the last exercise ({last_name})", open_card(page)[0] == last_name)

    nxt = page.get_by_role("button", name=re.compile(r"^Next: "))
    label = nxt.first.inner_text().strip()
    check(f"the button names where it will take you ('{label}')", label.startswith("Next:"))
    nxt.first.scroll_into_view_if_needed()
    nxt.first.click()
    page.wait_for_timeout(700)

    name, head = open_card(page)
    check(f"it opened an exercise that still has work left ({name})", name is not None)
    if head is not None:
        dot = page.locator(".ex-card", has=page.get_by_role("button", name=re.compile(re.escape(name)))).first.locator(".status-dot").first
        check(f"that exercise is unfinished (progress '{dot.inner_text().strip()}')", "/" in dot.inner_text())
        box = head.bounding_box()
        y = -1 if box is None else box["y"]
        check(f"and it was scrolled into view (header y={round(y)})", box is not None and -5 <= y <= 844)
        check("the button named the exercise it actually opened", name in label)
    page.screenshot(path=str(SHOTS / "11-next-unfinished.png"), full_page=False)

    # Finish the rest so the workout can be discarded cleanly.
    page.get_by_role("button", name=re.compile("Discard workout")).click()
    page.get_by_role("button", name="Discard", exact=True).click()
    page.wait_for_timeout(500)

    check(f"no console errors ({errors})", not errors)
    browser.close()

failed = [n for n, ok in results if not ok]
print("")
print("%d/%d checks passed" % (len(results) - len(failed), len(results)))
if failed:
    print("FAILED: " + "; ".join(failed))
    sys.exit(1)
