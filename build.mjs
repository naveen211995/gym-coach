// Builds the app for GitHub Pages. Outputs, all at the repo root:
//
//   index.html                 the app, self-contained (React, CSS, icons inlined)
//   sw.js                      service worker, so a cold launch works offline
//   manifest.webmanifest       installable / standalone metadata
//   icon-512.png               icons the manifest points at (the HTML inlines its
//   apple-touch-icon-180.png   own copies, so index.html still works alone)
//
// index.html on its own is a complete working app; the other four files are
// progressive enhancement for the installed, offline experience.
//
// Every URL here is RELATIVE. Pages serves this project from /<repo>/, not from
// the domain root, so an absolute "/sw.js" would 404.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// React is bundled in rather than fetched from a CDN: launching from the home
// screen in a gym basement must not depend on cdnjs being reachable.
const res = await build({
  entryPoints: ['src/ui/main.tsx'],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'safari14'],
  minify: true,
  write: false,
  jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('src/ui/styles.css', 'utf8');

const ICONS = { icon: 'icon-512.png', apple: 'apple-touch-icon-180.png' };
const iconPath = (f) => `src/ui/icons/${f}`;
const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

const manifest = {
  name: 'Gym Progression Coach',
  short_name: 'Gym Coach',
  description: 'Local-first workout logger with a deterministic, explainable progression engine.',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#e9ecee',
  theme_color: '#e9ecee',
  icons: [
    { src: `./${ICONS.icon}`, sizes: '512x512', type: 'image/png' },
    { src: `./${ICONS.apple}`, sizes: '180x180', type: 'image/png' },
  ],
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#e9ecee" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#151a1e" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Gym Coach">
<meta name="mobile-web-app-capable" content="yes">
<title>Gym Progression Coach</title>
<link rel="icon" href="${dataUri(iconPath(ICONS.icon))}">
<link rel="apple-touch-icon" href="${dataUri(iconPath(ICONS.apple))}">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@500;600;700&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<noscript>Gym Progression Coach needs JavaScript.</noscript>
<script>${js}</script>
<script>
// Best-effort and deliberately silent: registration throws on file:// and
// anywhere service workers are unavailable, and a failure must never surface
// as a console error or stop the app working.
if ('serviceWorker' in navigator) {
  addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
}
</script>
</body>
</html>
`;

writeFileSync('index.html', html);

// One cache per build: the id changes whenever the app changes, so the worker's
// activate step deletes the previous cache instead of serving a stale shell.
const buildId = createHash('sha256').update(html).digest('hex').slice(0, 12);
const swSource = readFileSync('src/ui/sw.js', 'utf8');
if (!swSource.includes('__BUILD_ID__')) throw new Error('src/ui/sw.js has no __BUILD_ID__ placeholder');
writeFileSync('sw.js', swSource.replace('__BUILD_ID__', buildId));

writeFileSync('manifest.webmanifest', `${JSON.stringify(manifest, null, 2)}\n`);
for (const f of Object.values(ICONS)) copyFileSync(iconPath(f), f);

// Optional extra copy (sandboxed environments); set BUILD_COPY_TO to enable.
const extra = process.env.BUILD_COPY_TO;
if (extra) {
  try {
    mkdirSync(extra, { recursive: true });
    copyFileSync('index.html', `${extra}/gym-progression-coach.html`);
  } catch (e) {
    console.warn(`Could not copy to ${extra}: ${e.message}`);
  }
}

console.log(`index.html ${(html.length / 1024).toFixed(1)} KB  (build ${buildId})`);
console.log(`sw.js, manifest.webmanifest, ${Object.values(ICONS).join(', ')}`);
