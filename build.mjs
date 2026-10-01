// Bundles the app into ONE self-contained HTML file (React from cdnjs UMD).
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const REACT = '18.2.0';
const globals = { react: 'React', 'react-dom': 'ReactDOM', 'react-dom/client': 'ReactDOM' };
const umdGlobals = {
  name: 'umd-globals',
  setup(b) {
    b.onResolve({ filter: /^react(-dom(\/client)?)?$/ }, (a) => ({ path: a.path, namespace: 'g' }));
    b.onLoad({ filter: /.*/, namespace: 'g' }, (a) => ({ contents: `module.exports = window.${globals[a.path]};`, loader: 'js' }));
  },
};

const res = await build({
  entryPoints: ['src/ui/main.tsx'],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'safari14'],
  minify: true,
  write: false,
  jsx: 'transform',
  plugins: [umdGlobals],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('src/ui/styles.css', 'utf8');
const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const icon = dataUri('src/ui/icons/icon-512.png');
const appleIcon = dataUri('src/ui/icons/apple-touch-icon-180.png');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#e9ecee" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#151a1e" media="(prefers-color-scheme: dark)">
<title>Gym Progression Coach</title>
<link rel="icon" href="${icon}">
<link rel="apple-touch-icon" href="${appleIcon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@500;600;700&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<noscript>Gym Progression Coach needs JavaScript.</noscript>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/${REACT}/umd/react.production.min.js" crossorigin="anonymous"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/${REACT}/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
<script>${js}</script>
</body>
</html>
`;
// GitHub Pages serves a branch root (or /docs), never /dist, so the root
// index.html IS the deployed app. One generated artifact in one place: there
// is no second copy for src/ to drift away from.
writeFileSync('index.html', html);
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
console.log(`index.html ${(html.length / 1024).toFixed(1)} KB`);
