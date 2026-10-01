"""
End-to-end smoke test in headless Chromium at iPhone size.
React is inlined in the build, so cdnjs is blocked outright; fonts are blocked too (fallback stack).
Checks: renders every screen, logs sets, auto-computes next target, data survives reload (IndexedDB),
JSON export -> erase -> import round-trip, CSV export, no console errors.
"""
import json, os, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ORIGIN, install_routes, ignorable, missing_outputs  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "shots"
errors, results = [], []

absent = missing_outputs()
if absent:
    sys.exit("Missing build output: %s -- run `node build.mjs` first." % ", ".join(absent))

def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    install_routes(page)
    page.goto(ORIGIN + "/")

    expect(page.get_by_role("heading", name=re.compile("Today"))).to_be_visible(timeout=15000)
    page.screenshot(path=str(SHOTS / "01-home.png"), full_page=True)
    check("home shows next day Lower B", page.get_by_text("Lower B", exact=True).first.is_visible())
    check("home shows leg press target 270 lb", page.get_by_text("270 lb").first.is_visible())
    check("needs-attention lists the pain flag", page.get_by_text("Pain logged: review, replace or skip").is_visible())

    # Start workout with a normal check-in
    page.get_by_role("button", name="Train").click()
    page.get_by_role("button", name="Check in").click()
    page.get_by_role("radiogroup", name="Readiness").get_by_role("radio", name="4").click()
    page.get_by_role("radiogroup", name="Energy").get_by_role("radio", name="4").click()
    page.screenshot(path=str(SHOTS / "02-start.png"), full_page=True)
    page.get_by_role("button", name=re.compile("Start Lower B")).click()
    expect(page.get_by_text("Leg Press").first).to_be_visible()
    page.screenshot(path=str(SHOTS / "03-active.png"), full_page=False)
    check("target plate shows recommendation reason", page.get_by_text(re.compile("looks like a one-off")).first.is_visible())

    # Log three sets with one tap each (defaults = targets)
    for i in range(3):
        page.get_by_role("button", name=re.compile(r"^Log 270")).click()
        page.wait_for_timeout(250)
    expect(page.get_by_text(re.compile("next time")).first).to_be_visible()
    result_line = page.locator(".result-line").first.inner_text()
    check(f"next target computed immediately: '{result_line}'", "Keep 270 lb" in result_line or "Increase" in result_line)
    page.screenshot(path=str(SHOTS / "04-result.png"), full_page=False)

    # Reload: IndexedDB persistence
    page.reload()
    expect(page.get_by_text("Lower B").first).to_be_visible(timeout=15000)
    check("after reload the workout is still in progress", page.get_by_text(re.compile(r"1 of 4 done")).is_visible())
    check("after reload leg press shows its next target", page.get_by_text(re.compile(r"Next: ")).first.is_visible())

    # Pain-flagged exercise
    head = page.get_by_role("button", name=re.compile("Lying Leg Curl"))
    check("after reload the next unfinished exercise is auto-expanded", head.get_attribute("aria-expanded") == "true")
    if head.get_attribute("aria-expanded") != "true":
        head.click()
    check("leg curl flagged for review", page.get_by_text("Flagged for review.").is_visible())
    page.screenshot(path=str(SHOTS / "05-pain-review.png"), full_page=False)

    # Hip thrust: log one set, then complete early (incomplete session)
    page.get_by_role("button", name=re.compile("Barbell Hip Thrust")).click()
    page.get_by_role("button", name=re.compile(r"^Log 225")).click()
    page.wait_for_timeout(200)

    # Finish workout
    page.get_by_role("button", name="Finish workout").click()
    page.get_by_role("button", name="Finish and save").click()
    expect(page.get_by_text("Then recommended:").first).to_be_visible()
    page.screenshot(path=str(SHOTS / "06-workout-detail.png"), full_page=True)
    check("workout detail shows skipped leg curl", page.get_by_text("Skipped").first.is_visible())
    check("hip thrust partial session repeats", page.locator("text=Repeat 225 lb").count() >= 1)

    # Exercise detail (history -> recommendation timeline)
    page.get_by_role("button", name="History").click()
    page.get_by_role("button", name="Exercises", exact=True).click()
    page.get_by_role("button", name=re.compile("^Back Squat")).click()
    expect(page.get_by_text("DELOAD_REGRESSION").first).to_be_visible()
    page.screenshot(path=str(SHOTS / "07-exercise-detail.png"), full_page=True)

    page.get_by_role("button", name="Progress").click()
    page.wait_for_timeout(200)
    page.screenshot(path=str(SHOTS / "08-progress.png"), full_page=True)
    check("progress chart rendered", page.locator("svg.chart").count() == 1)

    # Backup: export JSON
    page.get_by_role("button", name="More").click()
    page.get_by_role("button", name=re.compile("Backup & restore")).click()
    with page.expect_download() as dl:
        page.get_by_role("button", name="Export full backup (JSON)").click()
    backup_path = SHOTS / "backup.json"
    dl.value.save_as(str(backup_path))
    data = json.loads(backup_path.read_text())
    wcount = len([w for w in data["data"]["workoutSessions"] if w["status"] == "completed"])
    check(f"backup has schemaVersion 1 and 21 workouts ({wcount})", data["schemaVersion"] == 1 and wcount == 21)
    with page.expect_download() as dl2:
        page.get_by_role("button", name="Export workout history (CSV)").click()
    csv_path = SHOTS / "sets.csv"
    dl2.value.save_as(str(csv_path))
    csv_lines = csv_path.read_text().strip().splitlines()
    check(f"CSV exported with header + rows ({len(csv_lines)})", csv_lines[0].startswith("date,workout,exercise") and len(csv_lines) > 200)
    page.screenshot(path=str(SHOTS / "09-backup.png"), full_page=True)

    # Erase, then restore from the file
    page.get_by_role("button", name="Erase everything").click()
    page.get_by_role("dialog").get_by_role("button", name="Erase").click()
    page.wait_for_timeout(300)
    page.reload()
    page.get_by_role("button", name="Home").click()
    check("erase persisted across reload (empty state)", page.get_by_text("Start your log").is_visible())
    page.screenshot(path=str(SHOTS / "10-empty.png"), full_page=True)
    page.get_by_role("button", name=re.compile("Load example data or restore")).click()
    page.locator("#import-file").set_input_files(str(backup_path))
    expect(page.get_by_text("Backup is valid.")).to_be_visible()
    page.get_by_role("button", name="Replace all").click()
    page.get_by_role("dialog").get_by_role("button", name="Replace").click()
    page.wait_for_timeout(300)
    page.reload()
    page.get_by_role("button", name="More").click()
    page.get_by_role("button", name=re.compile("Backup & restore")).click()
    check("import restored 21 workouts after reload", page.get_by_text(re.compile(r"^21 workouts")).is_visible())

    # Bad import is rejected cleanly
    page.locator("#paste").fill('{"app":"something-else"}')
    page.get_by_role("button", name="Check pasted backup").click()
    check("foreign JSON rejected", page.get_by_role("alert").filter(has_text="not a Gym Progression Coach backup").count() == 1)

    # Dark mode + library editor
    page.emulate_media(color_scheme="dark")
    page.get_by_role("button", name="More").click()
    page.get_by_role("button", name=re.compile("Exercise library")).click()
    page.get_by_role("button", name=re.compile("^Barbell Bench Press")).click()
    page.screenshot(path=str(SHOTS / "11-editor-dark.png"), full_page=True)
    page.locator("#ex-name").fill("")
    page.get_by_role("button", name="Save").click()
    check("editor validation blocks empty name", page.get_by_text("Give the exercise a name.").is_visible())

    # Horizontal overflow check on a narrow phone
    page.set_viewport_size({"width": 360, "height": 740})
    for tab in ["Home", "Train", "History", "Progress", "More"]:
        page.get_by_role("navigation", name="Main").get_by_role("button", name=tab, exact=True).click()
        page.wait_for_timeout(100)
        sw = page.evaluate("document.documentElement.scrollWidth")
        check(f"no horizontal scroll on {tab} at 360px ({sw})", sw <= 360)

    browser.close()

real_errors = [e for e in errors if not ignorable(e)]
check(f"no console errors ({real_errors[:3]})", not real_errors)
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
