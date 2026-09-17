#!/usr/bin/env node
// Build public static files locally. The hosting server does not need Node.js.
const fs = require('node:fs');
const path = require('node:path');
const SRC = path.join(__dirname, 'source');
const OUT = path.join(__dirname, 'docs');
const site = new URL(process.env.CORNU_SITE_URL || 'https://cornu.ai/');
if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash) {
  throw new Error('CORNU_SITE_URL must be an HTTPS website URL without credentials, query or fragment.');
}
if (!site.pathname.endsWith('/')) site.pathname += '/';
const pages = ['index.html', 'products/index.html', 'careers/index.html', 'simulation/index.html'];
const films = ['shot1', 'shot2', 'shot3'];
const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function publicMetadata(html, page) {
  const url = escapeAttribute(new URL(page.replace(/index\.html$/, ''), site).href);
  html = html.replace(/<meta name="robots"[^>]*>\s*/g, '');
  return html.replace('</head>',
    '<meta name="robots" content="index, follow">\n' +
    '<link rel="canonical" href="' + url + '">\n' +
    '<meta property="og:url" content="' + url + '">\n</head>');
}

// Preserve the existing bundled layout and optimised images. Videos stay separate
// so browsers can load them on demand and seek using normal HTTP range requests.
function marketingPage(page) {
  const dir = path.dirname(path.join(SRC, page));
  const read = rel => fs.readFileSync(path.resolve(dir, rel), 'utf8');
  let html = fs.readFileSync(path.join(SRC, page), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<link rel="stylesheet" href="((?:\.\.\/)*assets\/css\/cornu\.css)">/,
    (match, rel) => '<style>\n' + read(rel) + '\n</style>');
  html = html.replace(/<script src="((?:\.\.\/)*assets\/js\/cornu\.js)"[^>]*><\/script>/,
    (match, rel) => {
      const script = read(rel);
      new Function(script);
      return '<script>\n' + script + '\n</script>';
    });
  html = html.replace(/<link rel="icon"[^>]*href="((?:\.\.\/)*assets\/img\/favicon\.svg)"[^>]*>/,
    (match, rel) => '<link rel="icon" href="data:image/svg+xml,' + encodeURIComponent(read(rel).trim()) + '">');
  html = html.replace(/src="((?:\.\.\/)*assets\/img\/(?:partners|team)\/[^"?]+\.(png|jpe?g|webp))"/gi,
    (match, rel, ext) => {
      const mime = ext.toLowerCase() === 'webp' ? 'image/webp' : ext.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
      return 'src="data:' + mime + ';base64,' + fs.readFileSync(path.resolve(dir, rel)).toString('base64') + '"';
    });
  html = html.replace(/poster="((?:\.\.\/)*assets\/img\/film\/[^"?]+\.jpg)"/g,
    (match, rel) => 'poster="data:image/jpeg;base64,' + fs.readFileSync(path.resolve(dir, rel)).toString('base64') + '"');
  html = html.replace(/data-src="((?:\.\.\/)*)assets\/videos\/(shot[123])\.mp4"/g,
    (match, prefix, name) => 'data-src="' + prefix + 'media/' + name + '.mp4"');
  if (/(href|src|poster)="(?:\.\.\/)*assets\//.test(html)) {
    throw new Error('Unresolved asset reference in ' + page);
  }
  // Keep public content readable when JavaScript is disabled.
  html = html.replace('</head>', '<noscript><style>' +
    '#loader{display:none}body.is-loading{overflow:auto}' +
    '.rv,.flow-step,.chip{opacity:1!important;transform:none!important}' +
    '.film-play,form{display:none}' +
    '</style></noscript>\n</head>');
  html = html.replace(/<form\b/g, '<noscript><p>Please enable JavaScript to use this form, or email ' +
    (page.startsWith('careers/') ? '<a href="mailto:careers@cornu.ai">careers@cornu.ai</a>' : '<a href="mailto:hello@cornu.ai">hello@cornu.ai</a>') +
    '.</p></noscript>\n<form');
  return publicMetadata(html, page);
}

// Prepare pages and check inputs before replacing any published files.
const output = pages.map(page => ({page, html: page.startsWith('simulation/')
  ? publicMetadata(fs.readFileSync(path.join(SRC, page), 'utf8'), page)
  : marketingPage(page)}));
for (const film of films) fs.accessSync(path.join(SRC, 'assets/videos', film + '.mp4'));
fs.mkdirSync(path.join(OUT, 'media'), {recursive: true});
for (const {page, html} of output) {
  const dest = path.join(OUT, page);
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.writeFileSync(dest, html);
  console.log('docs/' + page + ' (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)');
}
for (const film of films) {
  fs.copyFileSync(path.join(SRC, 'assets/videos', film + '.mp4'), path.join(OUT, 'media', film + '.mp4'));
  // Remove only the known generated preview payloads, never authoring files.
  fs.rmSync(path.join(OUT, 'media', film + '.json'), {force: true});
}
fs.cpSync(path.join(SRC, 'simulation/assets'), path.join(OUT, 'simulation/assets'), {recursive: true});
const sitemap = new URL('sitemap.xml', site).href;
fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n\nSitemap: ' + sitemap + '\n');
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  pages.map(page => '  <url><loc>' + escapeAttribute(new URL(page.replace(/index\.html$/, ''), site).href) + '</loc></url>').join('\n') +
  '\n</urlset>\n');
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log('Public static site ready in docs/. Main address: ' + site.href);
