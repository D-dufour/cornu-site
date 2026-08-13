#!/usr/bin/env node
/**
 * Cornu — build a password-protected single file for static hosting.
 *
 *   node build.js
 *   CORNU_PASSWORD='some other password' node build.js
 *
 * Reads  ./source/   (the real site — never commit this to a public repo)
 * Writes ./docs/index.html      (gate + AES-256-GCM ciphertext of the whole site)
 *
 * The published file contains no readable markup. The password is not stored
 * anywhere in it — only a random salt, a random IV and the ciphertext.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PASSWORD = process.env.CORNU_PASSWORD || 'cornu2026!';
const ITERATIONS = 310000;           // PBKDF2-SHA256 rounds
const SRC = path.join(__dirname, 'source');
const OUT = path.join(__dirname, 'docs');

/* ---------- 1. inline the site into one document ---------- */
function inline() {
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(SRC, 'assets/css/cornu.css'), 'utf8');
  const js = fs.readFileSync(path.join(SRC, 'assets/js/cornu.js'), 'utf8');
  const ico = fs.readFileSync(path.join(SRC, 'assets/img/favicon.svg'), 'utf8');

  /* replacement FUNCTIONS, not strings — a literal replacement would treat
     "$$" in the source (e.g. the $$ query helper) as an escaped dollar */
  html = html.replace(/<link rel="stylesheet" href="assets\/css\/cornu\.css">/,
    () => '<style>\n' + css + '\n</style>');
  html = html.replace(/<script src="assets\/js\/cornu\.js"[^>]*><\/script>/,
    () => '<script>\n' + js + '\n</script>');
  html = html.replace(/<link rel="icon"[^>]*>/,
    () => '<link rel="icon" href="data:image/svg+xml,' + encodeURIComponent(ico.trim()) + '">');
  html = html.replace(/src="(assets\/img\/(?:partners|team)\/[^"?]+\.(png|jpe?g))"/gi, (match, rel, ext) => {
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file)) return match;
    const data = fs.readFileSync(file).toString('base64');
    const mime = ext.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
    return 'src="data:' + mime + ';base64,' + data + '"';
  });

  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  if (/(href|src)="assets\//.test(withoutComments)) {
    throw new Error('Unresolved asset reference — every asset must be inlined before encrypting.');
  }
  return html;
}

function inlineSimulation() {
  const sim = path.join(SRC, 'simulation');
  let html = fs.readFileSync(path.join(sim, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(sim, 'assets/css/cornu.css'), 'utf8');
  const scripts = [];
  html = html.replace(/<link rel="stylesheet" href="assets\/css\/cornu\.css">/,
    () => '<style>\n' + css + '\n</style>');
  html = html.replace(/<script src="(assets\/js\/[^"]+)"><\/script>/g, (match, rel) => {
    scripts.push(fs.readFileSync(path.join(sim, rel), 'utf8'));
    return '';
  });
  if (!scripts.length) throw new Error('Could not find the simulation scripts.');
  return html.replace('</body>', () => '<script>\n' + scripts.join('\n') + '\n</script>\n</body>');
}

function bundleDocument(html, label) {
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/i);
  if (!m) throw new Error('Could not find the ' + label + ' script — check the inline step.');
  try { new Function(m[1]); } catch (e) {
    throw new Error('The ' + label + ' script does not compile after inlining: ' + e.message);
  }
  return JSON.stringify({ h: html.replace(m[0], () => '</body>'), j: m[1] });
}

/* ---------- 2. encrypt ---------- */
function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([body, cipher.getAuthTag()]); // WebCrypto expects tag appended
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: payload.toString('base64'),
    iterations: ITERATIONS
  };
}

/* ---------- 3. the gate ---------- */
function gate(p) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Cornu</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23050706'/%3E%3Cg fill='none' stroke='%23C9F26E' stroke-width='4' stroke-linecap='round'%3E%3Cpath d='M32 56V30'/%3E%3Cpath d='M32 34 18 22'/%3E%3Cpath d='M32 34 46 22'/%3E%3Cpath d='M18 22 12 10'/%3E%3Cpath d='M18 22 24 12'/%3E%3Cpath d='M46 22 52 10'/%3E%3Cpath d='M46 22 40 12'/%3E%3C/g%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--carbon:#050706;--white:#F5F6F2;--muted:#79877D;--muted-2:#5A665E;--signal:#C9F26E;--ink:#0A0C0A;
        --ease:cubic-bezier(.22,.61,.36,1)}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:var(--carbon);color:var(--white);
       font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;
       display:grid;place-items:center;padding:24px;-webkit-font-smoothing:antialiased}
  .gate{width:100%;max-width:340px;text-align:center}
  svg{width:56px;height:56px;margin:0 auto}
  svg path{stroke:var(--signal);fill:none;stroke-width:5;stroke-linecap:round;
    stroke-dasharray:var(--len,420);stroke-dashoffset:var(--len,420);animation:draw .6s var(--ease) forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  .wm{font-family:"Archivo",Helvetica,Arial,sans-serif;font-weight:600;font-size:1rem;
      letter-spacing:.42em;text-indent:.42em;margin-top:22px}
  .note{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted-2);
        margin-top:14px;line-height:1.9}
  form{margin-top:34px;display:flex;flex-direction:column;gap:12px}
  input{background:transparent;border:0;border-bottom:1px solid rgba(245,246,242,.18);
        color:var(--white);font:inherit;font-size:.95rem;letter-spacing:.06em;
        padding:12px 0;text-align:center;border-radius:0;transition:border-color .3s var(--ease)}
  input::placeholder{color:var(--muted-2);letter-spacing:.2em;font-size:.68rem;text-transform:uppercase}
  input:focus{outline:none;border-bottom-color:var(--signal)}
  button{background:var(--signal);color:var(--ink);border:0;border-radius:999px;
         font:inherit;font-size:.68rem;font-weight:500;letter-spacing:.18em;text-transform:uppercase;
         padding:14px 20px;cursor:pointer;transition:background .3s var(--ease)}
  button:hover{background:#D9FA8C}
  button:disabled{background:#3A4239;color:var(--muted-2);cursor:default}
  .msg{font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;color:var(--muted-2);
       min-height:1.4em;margin-top:6px}
  .msg.bad{color:#E0705F}
  .bad-shake{animation:shake .3s var(--ease)}
  @keyframes shake{25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}
    svg path{stroke-dashoffset:0}}
</style>
</head>
<body>
  <main class="gate">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 60V32"/><path d="M32 34 16 20"/><path d="M32 34 48 20"/>
      <path d="M16 20 8 7"/><path d="M16 20 23 6"/><path d="M48 20 56 7"/><path d="M48 20 41 6"/>
    </svg>
    <div class="wm">CORNU</div>
    <p class="note">Not public yet.<br>Enter the password to continue.</p>
    <form id="f" autocomplete="off">
      <input id="pw" type="password" placeholder="Password" aria-label="Password" autofocus>
      <button id="go" type="submit">Enter</button>
    </form>
    <p class="msg" id="msg"></p>
  </main>

<script>
(function(){
  var D = {salt:"${p.salt}", iv:"${p.iv}", ct:"${p.ct}", it:${p.iterations}};
  var f=document.getElementById('f'), pw=document.getElementById('pw'),
      go=document.getElementById('go'), msg=document.getElementById('msg');

  function b64(s){var b=atob(s),u=new Uint8Array(b.length);
    for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}

  async function open(password){
    var enc=new TextEncoder();
    var base=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);
    var key=await crypto.subtle.deriveKey(
      {name:'PBKDF2',salt:b64(D.salt),iterations:D.it,hash:'SHA-256'},
      base,{name:'AES-GCM',length:256},false,['decrypt']);
    var plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64(D.iv)},key,b64(D.ct));
    return new TextDecoder().decode(plain);
  }

  function render(text){
    var o = JSON.parse(text);
    document.open();
    document.write(o.h);
    document.close();
    /* run the site's script in its own task, and in function scope, so the
       rewritten document's parser cannot also evaluate it */
    setTimeout(function(){
      try { new Function(o.j)(); }
      catch (err) { console.error('Cornu: site script failed', err); }
    }, 0);
  }

  async function attempt(password, quiet){
    go.disabled=true; msg.className='msg'; msg.textContent=quiet?'':'Unlocking…';
    try{
      var html=await open(password);
      try{ sessionStorage.setItem('cornu.k',password); }catch(e){}
      render(html);
    }catch(e){
      go.disabled=false;
      if(quiet){ msg.textContent=''; return; }
      msg.className='msg bad'; msg.textContent='Wrong password.';
      pw.value=''; pw.focus();
      document.querySelector('.gate').classList.add('bad-shake');
      setTimeout(function(){document.querySelector('.gate').classList.remove('bad-shake');},320);
    }
  }

  f.addEventListener('submit',function(e){ e.preventDefault();
    if(pw.value) attempt(pw.value,false); });

  document.querySelectorAll('svg path').forEach(function(p,i){
    var l=p.getTotalLength(); p.style.setProperty('--len',l);
    p.style.animationDelay=[0,.28,.28,.52,.58,.52,.58][i]+'s';
  });

  if(!(window.crypto&&crypto.subtle)){
    msg.className='msg bad';
    msg.textContent='This browser cannot decrypt the page. Use a current browser over https.';
    go.disabled=true;
  } else {
    var saved=null; try{ saved=sessionStorage.getItem('cornu.k'); }catch(e){}
    if(saved) attempt(saved,true);
  }
})();
</script>
</body>
</html>`;
}

/* ---------- run ---------- */
const bundle = bundleDocument(inline(), 'site');
const simulationBundle = bundleDocument(inlineSimulation(), 'simulation');

const payload = encrypt(bundle, PASSWORD);
const simulationPayload = encrypt(simulationBundle, PASSWORD);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), gate(payload));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
const simulationOut = path.join(OUT, 'simulation');
fs.rmSync(simulationOut, { recursive: true, force: true });
fs.mkdirSync(simulationOut, { recursive: true });
fs.writeFileSync(path.join(simulationOut, 'index.html'), gate(simulationPayload));

const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log('site      ' + kb(Buffer.byteLength(bundle)));
console.log('encrypted ' + kb(fs.statSync(path.join(OUT, 'index.html')).size));
console.log('password  ' + PASSWORD);
console.log('simulation ' + kb(Buffer.byteLength(simulationBundle)));
console.log('\nwrote encrypted docs/index.html and docs/simulation/index.html — commit docs/, never source/.');
