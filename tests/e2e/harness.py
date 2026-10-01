"""Shared Playwright harness for the E2E suites.

The built files are served by a real HTTP server bound to 127.0.0.1, for two
reasons:

  1. IndexedDB refuses to work from file://.
  2. Service workers require a *secure context*. 127.0.0.1 and localhost
     qualify; an arbitrary origin like http://gym.test does NOT, and there
     `navigator.serviceWorker` is undefined entirely. Route interception
     therefore cannot be used to fake an origin for these suites.

Third-party hosts are still blocked, via page.route:
  - cdnjs is aborted, so if React ever stops being inlined the suites fail
    loudly instead of quietly succeeding against the live CDN;
  - Google Fonts is aborted, so the suites exercise the CSS fallback stack.

Importing this module starts the server on a free port and exposes it as
ORIGIN. The thread is a daemon, so it goes away with the process.
"""
import re
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Everything `node build.mjs` emits at the repo root.
FILES = ("index.html", "sw.js", "manifest.webmanifest", "icon-512.png", "apple-touch-icon-180.png")

CDNJS = re.compile(r"https://cdnjs\.cloudflare\.com/.*")
FONTS = re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*")


class _Handler(SimpleHTTPRequestHandler):
    # SimpleHTTPRequestHandler has no mapping for .webmanifest.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".webmanifest": "application/manifest+json"}

    def log_message(self, *args):  # keep suite output readable
        pass

    def end_headers(self):
        # A service worker script must not be served from a stale HTTP cache.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def _start():
    handler = partial(_Handler, directory=str(ROOT))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return "http://127.0.0.1:%d" % httpd.server_port


ORIGIN = _start()


def missing_outputs():
    """Build outputs that are absent -- run `node build.mjs` first."""
    return [f for f in FILES if not (ROOT / f).exists()]


def install_routes(page):
    """Block third-party hosts. Same-origin files come from the real server."""
    page.route(CDNJS, lambda r: r.abort())
    page.route(FONTS, lambda r: r.abort())


def ignorable(message):
    """Console noise that is expected because we block third-party hosts."""
    return any(s in message for s in ("fonts.g", "ERR_FAILED", "ERR_ABORTED", "ERR_CONNECTION"))
