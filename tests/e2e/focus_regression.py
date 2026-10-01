"""
Regression test for the Sheet-component focus bug (see CLAUDE.md).

The bug: Sheet's focus effect listed `onClose` in its dependency array. Parents
pass `onClose` as an inline arrow, so every parent re-render produced a new
identity, re-running the effect. The cleanup restored focus to the opener and
the effect then focused the sheet container -- so typing in a sheet input lost
focus after the first keystroke and all later characters went nowhere.

The fix (src/ui/components.tsx): hold onClose in a ref, depend only on [open],
and don't re-focus when focus is already inside the sheet.

This test types a multi-character name into the routine-rename sheet, whose
input is bound to the PARENT's state -- the exact shape that triggered the bug.
Run after `node build.mjs`.
"""
import re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
HTML = ROOT / "dist" / "index.html"
SHOTS = ROOT / "shots"
NM = ROOT / "node_modules"
UMD = {
    "react.production.min.js": NM / "react/umd/react.production.min.js",
    "react-dom.production.min.js": NM / "react-dom/umd/react-dom.production.min.js",
}
TYPED = "Push Pull Legs"
errors, results = [], []


def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                              is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("https://cdnjs.cloudflare.com/**",
               lambda r: r.fulfill(path=str(UMD[r.request.url.rsplit("/", 1)[-1]]),
                                   content_type="application/javascript"))
    page.route(re.compile("https://fonts.(googleapis|gstatic).com/.*"), lambda r: r.abort())
    page.route("http://gym.test/**", lambda r: r.fulfill(path=str(HTML), content_type="text/html"))
    page.goto("http://gym.test/")

    expect(page.get_by_role("heading", name=re.compile("Today"))).to_be_visible(timeout=15000)

    # More -> Routine builder -> rename the active routine.
    page.get_by_role("button", name="More").click()
    page.get_by_role("button", name=re.compile("Routine builder")).click()
    page.get_by_role("button", name="Rename routine").click()

    sheet = page.get_by_role("dialog")
    expect(sheet).to_be_visible()
    name_input = sheet.get_by_label("Name")
    expect(name_input).to_be_visible()

    # The heart of the test: type character by character. Under the bug, the
    # input lost focus after the first keystroke and kept only one character.
    name_input.click()
    name_input.fill("")
    page.keyboard.type(TYPED, delay=40)

    value = name_input.input_value()
    check("every typed character reached the input (got %r)" % value, value == TYPED)
    check("focus stayed in the sheet input while typing",
          page.evaluate("document.activeElement?.getAttribute('aria-label')") == "Name")
    SHOTS.mkdir(exist_ok=True)
    page.screenshot(path=str(SHOTS / "focus-01-typing.png"), full_page=False)

    # onClose is reached through a ref now -- Escape must still close the sheet.
    page.keyboard.press("Escape")
    expect(page.get_by_role("dialog")).to_have_count(0)
    check("Escape still closes the sheet (onClose ref is live)", True)

    # Closing restores focus to the control that opened the sheet.
    check("focus returned to the opener on close",
          page.evaluate("document.activeElement?.getAttribute('aria-label')") == "Rename routine")

    # Saving from the sheet still works end to end.
    page.get_by_role("button", name="Rename routine").click()
    sheet = page.get_by_role("dialog")
    sheet.get_by_label("Name").fill("")
    page.keyboard.type(TYPED, delay=20)
    sheet.get_by_role("button", name="Save").click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    check("renamed routine persisted", page.get_by_text(TYPED, exact=True).first.is_visible())
    page.screenshot(path=str(SHOTS / "focus-02-saved.png"), full_page=False)

    # The workout "Add exercise" sheet keeps its own state; make sure it types too.
    page.get_by_role("button", name="Train").click()
    page.get_by_role("button", name=re.compile("^Start ")).click()
    page.get_by_role("button", name=re.compile("Add exercise")).click()
    search = page.get_by_role("dialog").get_by_label("Search exercises")
    search.click()
    page.keyboard.type("bench", delay=40)
    check("search field in a sheet keeps all keystrokes (got %r)" % search.input_value(),
          search.input_value() == "bench")

    browser.close()

real_errors = [e for e in errors if "fonts.g" not in e and "ERR_FAILED" not in e]
check("no console errors (%s)" % real_errors[:3], not real_errors)
failed = [n for n, ok in results if not ok]
print("\n%d/%d checks passed" % (len(results) - len(failed), len(results)))
sys.exit(1 if failed else 0)
