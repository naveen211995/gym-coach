"""
Installed-app behaviour: offline cold launch, manifest, and self-containment.

What this guards:
  - React is genuinely inlined. cdnjs is aborted by the harness, so the app
    must render with no third-party script at all.
  - The service worker registers, activates, and precaches the shell.
  - With the network fully offline, a reload still boots the app -- the point
    of the whole exercise, since a gym may have no signal.
  - Logged workout data in IndexedDB survives an offline launch.
  - The manifest is valid, standalone, and uses RELATIVE urls (GitHub Pages
    serves this from /<repo>/, so absolute paths would 404).

Run after `node build.mjs`.
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ORIGIN, ROOT, install_routes, ignorable, missing_outputs  # noqa: E402

SHOTS = ROOT / "shots"
errors, results = [], []

absent = missing_outputs()
if absent:
    sys.exit("Missing build output: %s -- run `node build.mjs` first." % ", ".join(absent))


def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)


# ---------- static checks on the emitted files ----------
manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
check("manifest is standalone", manifest.get("display") == "standalone")
check("manifest start_url and scope are relative",
      manifest.get("start_url", "").startswith("./") and manifest.get("scope", "").startswith("./"))
check("manifest icon srcs are relative",
      bool(manifest.get("icons")) and all(i["src"].startswith("./") for i in manifest["icons"]))

html = (ROOT / "index.html").read_text(encoding="utf-8")
check("no cdnjs reference remains in the html", "cdnjs" not in html)
check("apple standalone meta present", 'name="apple-mobile-web-app-capable"' in html)
check("manifest linked relatively", 'href="./manifest.webmanifest"' in html)
check("service worker registered relatively", "register('./sw.js')" in html)

sw = (ROOT / "sw.js").read_text(encoding="utf-8")
check("sw build id was substituted", "__BUILD_ID__" not in sw)
check("sw precaches only relative urls",
      all(u.startswith("./") for u in re.findall(r"'(\./[^']*)'", sw)))

# ---------- live browser checks ----------
with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                              is_mobile=True, has_touch=True, service_workers="allow")
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    install_routes(page)
    page.goto(ORIGIN + "/")

    # If React were still coming from cdnjs this would never render.
    expect(page.get_by_role("heading", name=re.compile("Today"))).to_be_visible(timeout=15000)
    check("app renders with cdnjs blocked (React really is inlined)", True)

    # Wait for the worker to take control.
    page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null",
                           timeout=15000)
    check("service worker activated and controls the page", True)

    state = page.evaluate("""async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const names = await caches.keys();
      const cache = names.length ? await caches.open(names[0]) : null;
      const keys = cache ? (await cache.keys()).map(r => new URL(r.url).pathname) : [];
      return { scope: reg ? reg.scope : null, names, keys };
    }""")
    check("one versioned cache exists (%s)" % state["names"],
          len(state["names"]) == 1 and state["names"][0].startswith("gpc-"))
    check("shell precached (%d entries)" % len(state["keys"]), len(state["keys"]) >= 3)

    # Log a set so there is real data to survive the offline launch.
    page.get_by_role("button", name="Train").click()
    page.get_by_role("button", name=re.compile("^Start ")).click()
    page.get_by_role("button", name=re.compile(r"^Log ")).first.click()
    page.wait_for_timeout(400)
    check("a set was logged before going offline",
          page.get_by_text(re.compile(r"1/\d|next time")).first.is_visible())

    # ---------- the real test: no network at all ----------
    ctx.set_offline(True)
    page.reload()
    expect(page.get_by_role("heading")).to_be_visible(timeout=20000)
    check("app boots offline from the service worker cache", True)
    SHOTS.mkdir(exist_ok=True)
    page.screenshot(path=str(SHOTS / "offline-01-boot.png"), full_page=False)

    page.get_by_role("button", name="Home").click()
    page.wait_for_timeout(300)
    offline_ok = page.evaluate("() => !!document.querySelector('.app') && document.body.innerText.length > 50")
    check("offline app is interactive, not an error page", offline_ok)

    # The workout in progress must still be there: IndexedDB is independent of
    # the network, and the cached shell must not have reset it.
    still_active = page.get_by_text(re.compile("In progress|Resume")).count() > 0
    check("in-progress workout survived the offline reload", still_active)
    page.screenshot(path=str(SHOTS / "offline-02-data.png"), full_page=True)

    ctx.set_offline(False)
    browser.close()

real_errors = [e for e in errors if not ignorable(e)]
check("no console errors (%s)" % real_errors[:3], not real_errors)
failed = [n for n, ok in results if not ok]
print("\n%d/%d checks passed" % (len(results) - len(failed), len(results)))
sys.exit(1 if failed else 0)
