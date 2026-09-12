const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../docs');
let server,browser,base;
before(async()=>{
  server=http.createServer((req,res)=>{
    let file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
    if(!fs.existsSync(file)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch(process.env.PW_CHANNEL?{channel:process.env.PW_CHANNEL}:{});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
async function open(url='/',viewport={width:1440,height:1000}){
  const context=await browser.newContext({viewport,reducedMotion:'reduce'});
  await context.addInitScript(password=>sessionStorage.setItem('cornu.k',password),process.env.CORNU_PASSWORD||'cornu2026!');
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&m.text().startsWith('Cornu:'))errors.push(m.text());});
  await ready(page,url);return {context,page,errors};
}
async function ready(page,url){await page.goto(base+url);await page.locator('main').waitFor();await page.waitForFunction(()=>!document.body.classList.contains('is-loading'));await page.evaluate(()=>document.fonts.ready);}
async function jump(page,selector){await page.locator(selector).scrollIntoViewIfNeeded();await page.waitForTimeout(80);}
async function fit(page,label){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' has horizontal overflow');}

test('careers links open the new page and role links select the correct application',async()=>{
  const {context,page,errors}=await open();
  try{
    assert.equal(await page.locator('#navLinks a[href="careers/"]').count(),1);
    const rows=await page.locator('.role-row').evaluateAll(els=>els.map(e=>({href:e.getAttribute('href'),title:e.querySelector('.t').textContent})));
    for(const row of rows){
      await ready(page,'/'+row.href);
      assert.equal(await page.locator('h1').count(),1);
      const role=new URL(row.href,base).searchParams.get('role');
      assert.equal(await page.locator('#a-role').inputValue(),role);
      assert.equal(await page.locator('#role-'+role).getAttribute('open'),'');
      await page.locator('#role-'+role+' .apply-role').click();
      assert.equal(await page.locator('#a-role').inputValue(),role);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'a-name');
    }
    await page.locator('.apply-role[data-role="open"]').click();
    assert.equal(await page.locator('#a-role').inputValue(),'open');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('application validates input, prepares the correct copy and handles clipboard failure',async()=>{
  const {context,page,errors}=await open('/careers/');
  try{
    await jump(page,'#apply');await page.locator('#copyApplication').click();
    assert.equal(await page.locator('#a-role').getAttribute('aria-invalid'),'true');
    await page.locator('#a-role').selectOption('perception');
    await page.locator('#a-name').fill('Test Applicant');await page.locator('#a-email').fill('applicant@example.com');
    await page.locator('#a-message').fill('I built and evaluated a vessel tracking pipeline using camera and radar data.');
    await page.locator('#copyApplication').click();
    assert.equal(await page.locator('#a-experience').getAttribute('aria-invalid'),'true');
    await page.locator('#a-experience').selectOption({label:'3-5 years'});
    await page.locator('#a-languages').fill('   ');await page.locator('#a-skills').fill('   ');
    await page.locator('#copyApplication').click();
    assert.equal(await page.locator('#a-languages').getAttribute('aria-invalid'),'true');
    assert.equal(await page.locator('#a-skills').getAttribute('aria-invalid'),'true');
    await page.locator('#a-languages').fill('Python (4 years), C++ (2 years)');
    await page.locator('#a-skills').fill('PyTorch training, OpenCV calibration, Git and Linux.');
    await page.locator('#a-education').fill('Robotics MSc');
    await page.locator('#a-motivation').fill('I want to apply perception to inland waterways.');
    await page.locator('#a-code').fill('javascript:alert(1)');await page.locator('#copyApplication').click();
    assert.equal(await page.locator('#a-code').getAttribute('aria-invalid'),'true');
    await page.locator('#a-code').fill('https://example.com/code');
    await page.locator('#a-profile').fill('javascript:alert(1)');await page.locator('#copyApplication').click();
    assert.equal(await page.locator('#a-profile').getAttribute('aria-invalid'),'true');
    await page.locator('#a-profile').fill('https://example.com/portfolio');
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedApplication=text;}}});});
    await page.locator('#copyApplication').click();
    const copied=await page.evaluate(()=>window.copiedApplication);
    assert.match(copied,/To: careers@cornu.ai/);assert.match(copied,/Perception Engineer/);assert.match(copied,/Test Applicant/);assert.match(copied,/https:\/\/example.com\/portfolio/);
    for(const expected of ['3-5 years','Python (4 years), C++ (2 years)','PyTorch training, OpenCV calibration, Git and Linux.','Robotics MSc','https://example.com/code','I want to apply perception to inland waterways.'])assert.ok(copied.includes(expected),'Missing applicant detail: '+expected);
    assert.match(await page.locator('#applicationStatus').innerText(),/Nothing has been sent/);
    await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw new Error('Permission denied');};});
    await page.locator('#copyApplication').click();
    assert.equal(await page.locator('#applicationText').inputValue(),copied);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'applicationText');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('all marketing pages fit phone, tablet and desktop widths; mobile menu works after scrolling',async()=>{
  for(const viewport of [{width:320,height:568},{width:390,height:844},{width:768,height:1024},{width:1024,height:768},{width:1440,height:1000},{width:844,height:390}]){
    const {context,page,errors}=await open('/',viewport);
    try{
      for(const url of ['/','/products/','/careers/']){
        await ready(page,url);
        for(const selector of await page.locator('main>section[id]').evaluateAll(es=>es.map(e=>'#'+e.id))){await jump(page,selector);await fit(page,url+' '+selector+' at '+viewport.width);}
        await fit(page,url+' at '+viewport.width);
        if(viewport.width<=1100){
          await page.locator('#burger').click();
          assert.equal(await page.locator('#burger').getAttribute('aria-expanded'),'true');
          const link=page.locator('#navLinks a').first();
          assert.ok(await link.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'Menu link must fit the viewport');
          await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#navLinks a')),true);
          await page.keyboard.press('Escape');assert.equal(await page.locator('#burger').getAttribute('aria-expanded'),'false');
          await page.locator('#burger').click();await link.click();
          await page.waitForFunction(()=>document.getElementById('burger')?.getAttribute('aria-expanded')==='false');
        }
      }
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  }
});

test('local navigation and anchor targets resolve across all marketing pages',async()=>{
  const {context,page}=await open();
  try{
    const pages=new Map();
    for(const url of ['/','/products/','/careers/']){
      await ready(page,url);
      pages.set(url,await page.evaluate(()=>({ids:[...document.querySelectorAll('[id]')].map(e=>e.id),links:[...document.querySelectorAll('a[href]')].map(e=>e.getAttribute('href'))})));
    }
    for(const [url,data] of pages)for(const href of data.links){
      const link=new URL(href,base+url);if(link.origin!==base)continue;
      if(link.hash&&pages.has(link.pathname))assert.ok(pages.get(link.pathname).ids.includes(link.hash.slice(1)),url+' has a broken anchor '+href);
      assert.equal((await fetch(link)).status,200,url+' has a broken link '+href);
    }
  }finally{await context.close();}
});

test('phone simulation keeps the scene, playback, camera and scenario controls usable',async()=>{
  const {context,page,errors}=await open('/simulation/',{width:390,height:844});
  try{
    await page.waitForFunction(()=>document.querySelector('#vesselRows').children.length>0);
    await fit(page,'Simulation');
    assert.ok(await page.locator('#scene').evaluate(e=>e.getBoundingClientRect().width>=300));
    await page.locator('#playPause').click();assert.equal((await page.locator('#playPause').innerText()).toLowerCase(),'play');
    await page.locator('[data-panel="sensorPanel"]').click();
    assert.equal(await page.locator('#sensorPanel').isVisible(),true);
    await page.locator('#camModes [data-v="bird"]').click();assert.match(await page.locator('#camModes [data-v="bird"]').getAttribute('class'),/on/);
    await page.locator('[data-panel="vesselPanel"]').click();assert.equal(await page.locator('#sensorPanel').isVisible(),false);
    assert.equal(await page.locator('#vesselPanel').isVisible(),true);
    await page.locator('#scenarios [data-v="bridge"]').click();assert.match(await page.locator('#scenarios [data-v="bridge"]').getAttribute('class'),/on/);
    await fit(page,'Simulation after controls');assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('new careers page stays gated; home assets and original scroll stage sizes are preserved',async()=>{
  const locked=await browser.newContext();
  try{
    const page=await locked.newPage();await page.goto(base+'/careers/');
    assert.equal(await page.locator('#pw').isVisible(),true);
    assert.equal(await page.locator('#applicationForm').count(),0);
    await page.locator('#pw').fill('incorrect-test-password');await page.locator('#go').click();
    await page.waitForFunction(()=>document.querySelector('#msg').classList.contains('bad'));
    assert.equal(await page.locator('#applicationForm').count(),0);
    await page.locator('#pw').fill(process.env.CORNU_PASSWORD||'cornu2026!');await page.locator('#go').click();
    await page.locator('#applicationForm').waitFor();
  }finally{await locked.close();}
  const {context,page,errors}=await open();
  try{
    assert.deepEqual(await page.locator('.track').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height)),[4200,3400,4600,4000,4200]);
    await page.locator('#company').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>[...document.querySelectorAll('.mug img')].every(e=>e.complete&&e.naturalWidth>0));
    assert.equal(await page.locator('.mug img[src^="data:image/webp;"]').count(),3);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('film loads on demand behind the preview gate and plays inline on a phone',async()=>{
  const locked=await browser.newContext();
  try{
    const page=await locked.newPage(),media=[];page.on('request',r=>{if(r.url().includes('/media/'))media.push(r.url());});
    await page.goto(base+'/');await page.locator('#pw').waitFor();
    assert.equal(await page.locator('#cornuFilm').count(),0);assert.deepEqual(media,[]);
  }finally{await locked.close();}
  const {context,page,errors}=await open('/',{width:390,height:844});
  try{
    const requests=[];page.on('request',r=>{if(r.url().includes('/media/'))requests.push(r.url());});
    await jump(page,'#film');
    assert.equal(await page.locator('#cornuFilm').getAttribute('src'),null);
    assert.deepEqual(requests,[],'Reduced motion must wait for a play request');
    await page.locator('#filmPlay').click();
    await page.waitForFunction(()=>{const v=document.getElementById('cornuFilm');return !v.paused&&v.currentTime>.1;});
    assert.equal(requests.length,1);
    assert.equal(await page.locator('#cornuFilm').evaluate(v=>v.muted&&v.playsInline&&v.videoWidth===1920),true);
    await fit(page,'Phone film');
    const r=await page.locator('#cornuFilm').boundingBox();assert.ok(Math.abs(r.width/r.height-16/9)<.02,'Film keeps its original aspect ratio');
    await jump(page,'#company');await page.waitForFunction(()=>document.getElementById('cornuFilm').paused);
    await jump(page,'#film');assert.equal(await page.locator('#cornuFilm').evaluate(v=>v.paused),true);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('film autoplay pauses offscreen, respects manual pause and retries a failed load',async()=>{
  const {context,page,errors}=await open();
  try{
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('#cornuFilm').evaluate(e=>e.scrollIntoView({behavior:'instant',block:'center'}));
    await page.waitForFunction(()=>{const v=document.getElementById('cornuFilm');return !v.paused&&v.currentTime>.1;});
    await page.locator('#company').evaluate(e=>e.scrollIntoView({behavior:'instant'}));
    await page.waitForFunction(()=>document.getElementById('cornuFilm').paused);
    await page.locator('#cornuFilm').evaluate(e=>e.scrollIntoView({behavior:'instant',block:'center'}));
    await page.waitForFunction(()=>!document.getElementById('cornuFilm').paused);
    await page.locator('#cornuFilm').evaluate(v=>v.pause());await page.waitForTimeout(100);
    await page.locator('#company').evaluate(e=>e.scrollIntoView({behavior:'instant'}));await page.waitForTimeout(100);
    await page.locator('#cornuFilm').evaluate(e=>e.scrollIntoView({behavior:'instant',block:'center'}));await page.waitForTimeout(200);
    assert.equal(await page.locator('#cornuFilm').evaluate(v=>v.paused),true,'Scrolling back must respect a manual pause');
    await page.emulateMedia({reducedMotion:'reduce'});await ready(page,'/');
    await page.route('**/media/shot1.json',r=>r.abort());
    await page.locator('#filmPlay').click();await page.waitForFunction(()=>document.getElementById('filmStatus').textContent.includes('could not load'));
    await page.unroute('**/media/shot1.json');await page.locator('#filmPlay').click();
    await page.waitForFunction(()=>!document.getElementById('cornuFilm').paused);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('Bridge Watch film loads independently and both players keep their own controls',async()=>{
  const {context,page,errors}=await open('/',{width:390,height:844});
  try{
    const requests=[];page.on('request',r=>{if(r.url().includes('/media/'))requests.push(new URL(r.url()).pathname);});
    await page.locator('#bridgeFilmFrame').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#cornuBridgeFilm').getAttribute('src'),null);
    assert.equal(await page.locator('#cornuFilm').getAttribute('src'),null);
    await page.locator('#bridgeFilmFrame .film-play').click();
    await page.waitForFunction(()=>{const v=document.getElementById('cornuBridgeFilm');return !v.paused&&v.currentTime>.1;});
    assert.deepEqual(requests,['/media/shot2.json']);
    assert.equal(await page.locator('#cornuBridgeFilm').evaluate(v=>v.muted&&v.playsInline&&v.videoWidth===1920),true);
    assert.equal(await page.locator('#cornuFilm').getAttribute('src'),null);
    await fit(page,'Bridge Watch film');
    await page.locator('#filmPlay').click();
    await page.waitForFunction(()=>!document.getElementById('cornuFilm').paused&&document.getElementById('cornuBridgeFilm').paused);
    assert.deepEqual(requests,['/media/shot2.json','/media/shot1.json']);
    await page.locator('#bridgeFilmFrame .film-play').click();
    await page.waitForFunction(()=>!document.getElementById('cornuBridgeFilm').paused&&document.getElementById('cornuFilm').paused);
    assert.equal(requests.length,2,'Returning to a loaded film must not download it again');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('Bridge Watch product film resolves from its nested page and the concise layout stays usable',async()=>{
  const {context,page,errors}=await open('/products/',{width:390,height:844});
  try{
    assert.equal(await page.locator('h1').innerText(),'Bridge Watch.');
    assert.equal(await page.locator('#productFilm').getAttribute('data-encrypted-src'),'../media/shot2.json');
    const media=page.waitForResponse(r=>r.url()===base+'/media/shot2.json');
    await page.locator('#productFilmFrame .film-play').click();assert.equal((await media).status(),200);
    await page.waitForFunction(()=>{const v=document.getElementById('productFilm');return !v.paused&&v.currentTime>.1;});
    assert.ok(await page.locator('#productFilm').evaluate(v=>v.muted&&v.playsInline));
    await page.locator('.bw-text-link').click();
    assert.equal(new URL(page.url()).hash,'#how');
    await page.waitForFunction(()=>document.getElementById('productFilm').paused);
    await fit(page,'Bridge Watch page');
    assert.equal(await page.locator('.bw-actions a[href="../#contact"],.bw-contact a[href="../#contact"]').count(),2);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
