"""
E2E for the routine exercise picker.

Two things it guards, both about using the picker one-handed in a gym:
  1. The list is searchable, like every other exercise list in the app, and
     searching narrows only what is SHOWN -- an exercise ticked before typing
     stays selected and still gets saved.
  2. Save is pinned to the sheet footer. The list is longer than the sheet, and
     before this it sat under the list, so saving a day meant scrolling to the
     bottom to find the button.
"""
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ORIGIN, ignorable, install_routes, missing_outputs  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "shots"
VIEWPORT = {"width": 390, "height": 844}
errors, results = [], []

absent = missing_outputs()
if absent:
    sys.exit("Missing build output: %s -- run `node build.mjs` first." % ", ".join(absent))


def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport=VIEWPORT, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and not ignorable(m.text) else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    install_routes(page)
    page.goto(ORIGIN + "/")
    expect(page.get_by_role("heading", name=re.compile("Today"))).to_be_visible(timeout=20000)

    page.get_by_role("button", name="More").click()
    page.get_by_role("button", name=re.compile("Routine builder")).click()
    expect(page.get_by_role("heading", name="Routine builder")).to_be_visible()

    # Open the picker for the first day of the active routine.
    day = page.locator("section.card").first
    day_name = day.locator("h3").inner_text().strip()
    day.get_by_role("button", name=re.compile("Add exercises")).click()
    sheet = page.get_by_role("dialog")
    expect(sheet).to_be_visible()
    rows = sheet.locator("label.list-item")
    total = rows.count()
    check(f"picker for {day_name} lists the exercise library ({total} exercises)", total >= 8)

    save = sheet.get_by_role("button", name=re.compile(r"^Save"))
    body = sheet.locator(".sheet-body")
    scrollable = page.evaluate("el => el.scrollHeight - el.clientHeight", body.element_handle())
    check(f"the list is longer than the sheet, so it scrolls ({scrollable}px of overflow)", scrollable > 0)

    box = save.bounding_box()
    check("Save is on screen before scrolling anywhere (y=%s)" % (None if box is None else round(box["y"])),
          box is not None and box["y"] + box["height"] <= VIEWPORT["height"] + 1)

    # Tick the last exercise in the list, then search for something else: the
    # pick must survive being filtered out of sight.
    rows.last.scroll_into_view_if_needed()
    picked = rows.last.locator(".title").inner_text().strip()
    rows.last.locator("input[type=checkbox]").check()
    expect(save).to_have_text(re.compile(r"Save \(\d+\)"))
    before = save.inner_text()

    search = sheet.get_by_label("Search exercises")
    search.fill("press")
    page.wait_for_timeout(250)
    shown = [r.locator(".title").inner_text().strip() for r in rows.all()]
    check(f"search narrows the list ({len(shown)} of {total} shown: {shown[:3]})",
          0 < len(shown) < total and all("press" in n.lower() for n in shown))
    check(f"the pick made before searching is still counted ('{save.inner_text()}' == '{before}')",
          save.inner_text() == before)
    check("and the picker says so when a selection is hidden by the search",
          sheet.get_by_text(re.compile(r"hidden by the search")).count() == 1)

    box = save.bounding_box()
    check("Save stays pinned while the body is scrolled/filtered (y=%s)" % (None if box is None else round(box["y"])),
          box is not None and box["y"] + box["height"] <= VIEWPORT["height"] + 1)
    page.screenshot(path=str(SHOTS / "12-routine-picker.png"), full_page=False)

    search.fill("zzzz-no-such-exercise")
    page.wait_for_timeout(200)
    check("empty search result is explained, not blank",
          sheet.get_by_text(re.compile("No matching exercises")).count() == 1)

    save.click()
    page.wait_for_timeout(500)
    check("saving from the footer closes the sheet", page.get_by_role("dialog").count() == 0)
    check(f"the exercise picked while filtered was saved to the day ({picked})",
          page.locator("section.card").first.get_by_text(picked, exact=True).count() == 1)

    page.reload()
    expect(page.get_by_role("heading", name=re.compile("Today"))).to_be_visible(timeout=20000)
    page.get_by_role("button", name="More").click()
    page.get_by_role("button", name=re.compile("Routine builder")).click()
    check("and it survived a reload (IndexedDB)",
          page.locator("section.card").first.get_by_text(picked, exact=True).count() == 1)

    browser.close()

check(f"no console errors ({errors[:3]})", not errors)
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
