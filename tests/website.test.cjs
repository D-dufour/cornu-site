const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../docs');
let server,browser,base;

before(async()=>{
  server=http.createServer((req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    let target=path.resolve(root,'.'+pathname);
    if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    if(fs.existsSync(target)&&fs.statSync(target).isDirectory())target=path.join(target,'index.html');
    if(!fs.existsSync(target)){res.writeHead(404).end();return;}
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
    res.setHeader('Content-Type',mime[path.extname(target)]||'application/octet-stream');
    fs.createReadStream(target).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch(process.env.PW_CHANNEL?{channel:process.env.PW_CHANNEL}:{});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});

async function open(options={},url='/'){
  const context=await browser.newContext({viewport:{width:1440,height:1000},...options});
  const errors=[];
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  // Exercise the same decryption and script installation used on GitHub Pages.
  await context.addInitScript(password=>sessionStorage.setItem('cornu.k',password),process.env.CORNU_PASSWORD||'cornu2026!');
  await page.goto(base+url);await page.locator('main h1').waitFor();
  await page.evaluate(()=>document.fonts.ready);
  return {context,page,errors};
}
async function jump(page,selector,fraction=0){
  await page.evaluate(({selector,fraction})=>{
    const el=document.querySelector(selector);
    scrollTo({top:el.getBoundingClientRect().top+scrollY+Math.max(0,el.offsetHeight-innerHeight)*fraction,behavior:'instant'});
  },{selector,fraction});
  await page.waitForTimeout(180);
}

test('published home decrypts, scenes render and motion can be paused',async()=>{
  const {context,page,errors}=await open();
  try{
    assert.equal(await page.locator('h1').count(),1);
    assert.equal(await page.locator('#loader').count(),0);
    assert.ok(fs.statSync(path.join(root,'index.html')).size<600*1024,'Keep the published homepage below 600 KB');
    await page.getByRole('button',{name:'Pause motion'}).click();
    assert.equal(await page.locator('.motion-toggle').getAttribute('aria-pressed'),'true');
    const capture=()=>page.locator('#heroCanvas').evaluate(cv=>cv.toDataURL());
    await page.waitForTimeout(100);const still=await capture();
    await page.waitForTimeout(200);assert.equal(await capture(),still,'Paused scene must stay still');
    await page.getByRole('button',{name:'Play motion'}).click();
    await page.waitForTimeout(200);assert.notEqual(await capture(),still);
    for(const id of ['#maritime','#worldmodel']){
      await jump(page,id,.1);
      const first=await page.locator(id+' canvas').evaluate(cv=>cv.toDataURL());
      await jump(page,id,.9);
      assert.notEqual(await page.locator(id+' canvas').evaluate(cv=>cv.toDataURL()),first);
      assert.ok(await page.locator(id+' .scene').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=70&&r.bottom<=innerHeight;}),'Scene fits inside the sticky viewport');
    }
    await jump(page,'.net',.9);
    assert.match(await page.locator('#netCount').textContent(),/ILLUSTRATIVE/);
    await jump(page,'.net',.1);
    assert.equal(await page.locator('#netHead').textContent(),'One vessel sees a waterway.');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('phone and tablet layouts fit, navigation closes and keyboard focus stays in menu',async()=>{
  for(const width of [360,390,768,1024]){
    const {context,page,errors}=await open({viewport:{width,height:844}});
    try{
      for(const selector of ['.hero','#problem','#maritime','#worldmodel','.net','#company','#contact']){
        await jump(page,selector);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),selector+' overflows at '+width);
      }
      await page.locator('#burger').click();
      assert.equal(await page.locator('#burger').getAttribute('aria-expanded'),'true');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#navLinks a')),true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#burger').getAttribute('aria-expanded'),'false');
      await page.locator('#burger').click();await page.locator('#navLinks a').first().click();
      assert.equal(await page.locator('#burger').getAttribute('aria-expanded'),'false');
      if(width<=760)assert.equal(await page.locator('#maritime .stage').evaluate(el=>getComputedStyle(el).position),'relative');
      assert.deepEqual(errors,[]);
    }finally{await context.close();}
  }
});

test('reduced motion presents complete scenes and visible content without sticky tracks',async()=>{
  const {context,page,errors}=await open({reducedMotion:'reduce'});
  try{
    assert.equal(await page.locator('.motion-toggle').textContent(),'Play motion');
    for(const selector of ['#maritime','#worldmodel']){
      await jump(page,selector);
      assert.equal(await page.locator(selector+' .stage').evaluate(el=>getComputedStyle(el).position),'relative');
    }
    assert.equal(await page.locator('#wmObs').textContent(),'Illustrative');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('home and product links resolve, portraits load and form validation is accessible',async()=>{
  const {context,page,errors}=await open({reducedMotion:'reduce'});
  try{
    await jump(page,'#company');
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('.mug img')).every(img=>img.complete&&img.naturalWidth>0));
    const homeIds=await page.locator('[id]').evaluateAll(els=>els.map(el=>el.id));
    const homeLinks=await page.locator('a[href]').evaluateAll(els=>els.map(el=>el.getAttribute('href')));
    await jump(page,'#contact');
    await page.locator('#sendBtn').click();
    assert.equal(await page.locator('#f-name').getAttribute('aria-invalid'),'true');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'f-name');
    assert.match(await page.locator('#formStatus').textContent(),/Add/);
    await page.goto(base+'/products/');await page.locator('main h1').waitFor();
    const productIds=await page.locator('[id]').evaluateAll(els=>els.map(el=>el.id));
    const productLinks=await page.locator('a[href]').evaluateAll(els=>els.map(el=>el.getAttribute('href')));
    for(const [links,url] of [[homeLinks,base+'/'],[productLinks,base+'/products/']]){
      for(const href of links){
        const target=new URL(href,url);if(target.origin!==base)continue;
        if(target.hash){
          const ids=target.pathname.startsWith('/products')?productIds:homeIds;
          assert.ok(ids.includes(decodeURIComponent(target.hash.slice(1))),'Broken fragment: '+href);
        }else assert.equal((await fetch(target)).status,200,'Broken local link: '+href);
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
