(function(){
"use strict";
const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $  = (s,c)=> (c||document).querySelector(s);
const $$ = (s,c)=> Array.from((c||document).querySelectorAll(s));
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const lerp=(a,b,t)=>a+(b-a)*t;
const ease=t=>t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
/* deterministic pseudo-random — the same waterway every visit */
function rng(seed){let s=seed>>>0;return()=>{s^=s<<13;s>>>=0;s^=s>>17;s^=s<<5;s>>>=0;return s/4294967296;};}

/* ---------------- loader ---------------- */
(function(){
  const L=$('#loader'); if(!L) return;
  const paths=$$('#loader path'), delays=[0,.30,.30,.56,.62,.56,.62];
  if(RM){ paths.forEach(p=>{p.style.animation='none';p.style.strokeDashoffset=0;}); }
  else paths.forEach((p,i)=>{
    const len=p.getTotalLength();
    p.style.setProperty('--len',len);
    p.style.animationDelay=delays[i]+'s';
  });
  const wait = RM?200:1700;
  let done=false;
  const finish=()=>{ if(done) return; done=true;
    L.classList.add('done'); document.body.classList.remove('is-loading'); $('#rail').classList.add('on'); };
  if(document.readyState==='complete') setTimeout(finish,wait);
  else window.addEventListener('load',()=>setTimeout(finish,wait));
  setTimeout(finish,wait+1200);
})();

/* ---------------- nav ---------------- */
const nav=$('#nav'), burger=$('#burger'), links=$('#navLinks');
burger.addEventListener('click',()=>{
  const open=links.classList.toggle('open');
  burger.classList.toggle('open',open);
  burger.setAttribute('aria-expanded',open);
  document.body.style.overflow=open?'hidden':'';
});
$$('#navLinks a').forEach(a=>a.addEventListener('click',()=>{
  links.classList.remove('open');burger.classList.remove('open');document.body.style.overflow='';
}));

/* ---------------- telemetry rail ---------------- */
const railSecs=$$('[data-rail]'), rail=$('#rail');
railSecs.forEach(()=>{const b=document.createElement('b');rail.appendChild(b);});
const railTicks=$$('b',rail);
const readout=document.createElement('span');
readout.className='rd'; readout.textContent=railSecs[0].dataset.rail; rail.appendChild(readout);

/* ---------------- reveal ---------------- */
const lightSec=$('.cta-sec');

const io=new IntersectionObserver((es)=>{
  es.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target);} });
},{threshold:.18,rootMargin:'0px 0px -8% 0px'});
$$('.rv,.flow-step').forEach(el=>io.observe(el));
const chipIO=new IntersectionObserver((es)=>{
  es.forEach(e=>{ if(e.isIntersecting){
    $$('.chip',e.target).forEach((c,i)=>setTimeout(()=>c.classList.add('in'),i*55));
    chipIO.unobserve(e.target);
  }});
},{threshold:.4});
const chipsWrap=$('#inputChips'); if(chipsWrap) chipIO.observe(chipsWrap);

/* ---------------- canvas helper ---------------- */
function setup(cv,draw,{ambient=false}={}){
  const ctx=cv.getContext('2d');
  let w=0,h=0,dpr=1;
  function size(){
    const r=cv.getBoundingClientRect();
    if(!r.width||!r.height) return false;
    dpr=Math.min(window.devicePixelRatio||1,2);
    w=r.width;h=r.height;
    cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    return true;
  }
  const state={ctx,get w(){return w},get h(){return h},p:0,t:0,mx:0,my:0,vis:true};
  size();
  window.addEventListener('resize',()=>{size();if(!ambient||RM)draw(state);},{passive:true});
  new IntersectionObserver(es=>{state.vis=es[0].isIntersecting;},{threshold:0}).observe(cv);
  if(ambient&&!RM){
    let last=performance.now();
    (function loop(now){ state.t+=Math.min(now-last,50)/1000; last=now;
      if(state.vis&&w) draw(state); requestAnimationFrame(loop); })(last);
  } else { requestAnimationFrame(()=>{size();draw(state);}); }
  return {state,redraw:()=>{if(w)draw(state);},size};
}
function mono(ctx,size,weight){ctx.font=(weight||400)+' '+size+'px "IBM Plex Mono",monospace';}
const SIG='201,242,110';

/* ============================================================
   HERO — a corridor of observations moving past the vessel
   ============================================================ */
(function(){
  const cv=$('#heroCanvas'); if(!cv) return;
  const R=rng(20260809);
  const FAR=150, NEAR=4;
  const pts=[];
  for(let i=0;i<900;i++){
    const z=NEAR+R()*(FAR-NEAR), side=R()<.5?-1:1, spread=R()*4.4;
    pts.push({x:side*(13+spread+Math.sin(z*.08)*4.2), y:R()*3.2-1.2, z, s:R()<.05?1:0, r:R()});
  }
  for(let i=0;i<340;i++){ const z=NEAR+R()*(FAR-NEAR);
    pts.push({x:(R()*2-1)*13,y:2.7+R()*.4,z,s:R()<.028?1:0,r:R()}); }
  /* upper layer — structure and airspace above the channel */
  for(let i=0;i<300;i++){ const z=NEAR+R()*(FAR-NEAR);
    pts.push({x:(R()*2-1)*26,y:-1.4-R()*2.6,z,s:R()<.06?1:0,r:R(),up:1}); }
  const struts=[];
  for(let i=0;i<15;i++) struts.push({z:6+i*11+R()*8, side:R()<.5?-1:1, h:4.2+R()*6.4, w:R()<.35});
  let tmx=0,tmy=0;
  window.addEventListener('pointermove',e=>{ tmx=(e.clientX/window.innerWidth-.5); tmy=(e.clientY/window.innerHeight-.5); },{passive:true});

  setup(cv,(S)=>{
    const {ctx,w,h}=S;
    S.mx=lerp(S.mx,tmx,.045); S.my=lerp(S.my,tmy,.045);
    ctx.clearRect(0,0,w,h);
    const narrow=w<820;
    const cx=w*(narrow?.55:.68)+S.mx*w*0.045, hz=h*0.42+S.my*h*0.03;
    const f=Math.min(w,h)*0.92;
    const spd=RM?0:5.0;
    const proj=(p)=>{ if(p.z<=NEAR*.55) return null;
      const k=f/p.z; return {x:cx+p.x*k, y:hz+(p.y+1.2)*k*0.86, k}; };
    ctx.strokeStyle='rgba(245,246,242,.07)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(0,hz);ctx.lineTo(w,hz);ctx.stroke();
    /* navigable corridor edges */
    for(const side of [-1,1]){
      ctx.beginPath(); let first=true;
      for(let z=NEAR+.5;z<FAR;z+=3){ const q=proj({x:side*10,y:2.6,z}); if(!q)continue;
        first?(ctx.moveTo(q.x,q.y),first=false):ctx.lineTo(q.x,q.y); }
      ctx.strokeStyle='rgba('+SIG+',.16)';ctx.lineWidth=1;ctx.stroke();
    }
    /* infrastructure rising above the horizon */
    struts.forEach(s=>{
      s.z-=spd*0.016; if(s.z<NEAR) s.z+=FAR-NEAR;
      const a=proj({x:s.side*12.5,y:2.6,z:s.z}), b=proj({x:s.side*12.5,y:2.6-s.h,z:s.z});
      if(!a||!b) return;
      const al=Math.pow(clamp(1-s.z/FAR,0,1),.8)*.62;
      ctx.strokeStyle='rgba(245,246,242,'+(al*.42).toFixed(3)+')';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      const arm=(a.y-b.y)*.26;
      ctx.strokeStyle='rgba('+SIG+','+(al*.5).toFixed(3)+')';
      ctx.beginPath();
      if(s.w){ ctx.moveTo(b.x-arm,b.y);ctx.lineTo(b.x+arm,b.y); }
      else { ctx.moveTo(b.x-arm*.5,b.y+arm*.5);ctx.lineTo(b.x,b.y);ctx.lineTo(b.x+arm*.5,b.y+arm*.5); }
      ctx.stroke();
    });
    /* observations */
    for(const p of pts){
      p.z-=spd*0.016; if(p.z<NEAR) p.z+=FAR-NEAR;
      const q=proj(p); if(!q) continue;
      if(q.x<-60||q.x>w+60||q.y<-60||q.y>h+60) continue;
      const d=clamp(1-p.z/FAR,0,1), r=clamp(q.k*0.05,.5,2.3);
      if(p.s){
        const pulse=.5+.5*Math.abs(Math.sin(S.t*1.05+p.r*9));
        ctx.fillStyle='rgba('+SIG+','+(Math.pow(d,.8)*pulse*.95).toFixed(3)+')';
        ctx.fillRect(q.x-r,q.y-r,r*2,r*2);
      }else{
        ctx.fillStyle='rgba(245,246,242,'+(Math.pow(d,1.35)*(p.up?.34:.62)).toFixed(3)+')';
        ctx.beginPath();ctx.arc(q.x,q.y,r,0,6.283);ctx.fill();
      }
    }
  },{ambient:true});
})();

/* ============================================================
   BRANCHING GENERATOR — the mark, the river, the network
   ============================================================ */
function branchSegs(seed,depth,len0,spread){
  const R=rng(seed), segs=[], sp=[], kk=[];
  for(let d=0;d<=depth;d++){ sp.push(spread*(.72+R()*.5)); kk.push(.60+R()*.14); }
  (function grow(x,y,ang,len,d){
    const nx=x+Math.cos(ang)*len, ny=y+Math.sin(ang)*len;
    segs.push({x1:x,y1:y,x2:nx,y2:ny,d});
    if(d>=depth) return;
    grow(nx,ny,ang-sp[d],len*kk[d],d+1);
    grow(nx,ny,ang+sp[d],len*kk[d],d+1);
  })(0,0,-Math.PI/2,len0,0);
  segs.sort((a,b)=>a.d-b.d);
  return segs;
}

/* ---- problem section ornament: the same branching logic as the mark ---- */
const probSegs=branchSegs(11,5,1,.60);
(function(){
  const cv=$('#probCanvas'); if(!cv) return;
  const c=setup(cv,(S)=>{
    const {ctx,w,h}=S; ctx.clearRect(0,0,w,h);
    ctx.save(); ctx.translate(w/2,h*0.94); ctx.scale(h*0.30,h*0.30);
    const n=probSegs.length, show=n*clamp(S.p*1.3,0,1);
    ctx.lineCap='round';
    probSegs.forEach((s,i)=>{
      if(i>show) return;
      const t=clamp(show-i,0,1);
      ctx.strokeStyle= s.d>=4?'rgba('+SIG+',.55)':'rgba(245,246,242,.28)';
      ctx.lineWidth=clamp(.035-s.d*.006,.006,.035);
      ctx.beginPath();ctx.moveTo(s.x1,s.y1);
      ctx.lineTo(lerp(s.x1,s.x2,t),lerp(s.y1,s.y2,t));ctx.stroke();
    });
    ctx.restore();
  });
  window.__prob=c;
})();

/* ============================================================
   4 — STARTING WITH WATER
   ============================================================ */
const water=(function(){
  const cv=$('#waterCanvas'); if(!cv) return null;
  const R=rng(1181);
  const cloud=[];
  for(let i=0;i<520;i++) cloud.push({k:Math.pow(R(),.55),o:R(),side:R()<.5?-1:1,s:R(),v:R()});
  function lab(ctx,x,y,txt,a,white){
    mono(ctx,9.5,500); try{ctx.letterSpacing='.16em';}catch(e){}
    ctx.fillStyle=(white?'rgba(245,246,242,':'rgba('+SIG+',')+a.toFixed(3)+')';
    ctx.fillText(txt,x,y);
    try{ctx.letterSpacing='0px';}catch(e){}
  }
  function brackets(ctx,x,y,bw,bh,a){
    const c=Math.min(12,bw*.26,bh*.32);
    ctx.strokeStyle='rgba('+SIG+','+a.toFixed(3)+')';ctx.lineWidth=1.1;
    ctx.beginPath();
    ctx.moveTo(x,y+c);ctx.lineTo(x,y);ctx.lineTo(x+c,y);
    ctx.moveTo(x+bw-c,y);ctx.lineTo(x+bw,y);ctx.lineTo(x+bw,y+c);
    ctx.moveTo(x+bw,y+bh-c);ctx.lineTo(x+bw,y+bh);ctx.lineTo(x+bw-c,y+bh);
    ctx.moveTo(x+c,y+bh);ctx.lineTo(x,y+bh);ctx.lineTo(x,y+bh-c);
    ctx.stroke();
  }
  return setup(cv,(S)=>{
    const {ctx,w,h}=S, p=S.p, t=RM?0:S.t;
    ctx.clearRect(0,0,w,h);
    const narrow=w<820;
    const vx=w*(narrow?.50:.66), hz=h*(narrow?.56:.40);
    const ky=(k)=> Math.pow(1-k,1.30);
    const W=(k)=> 3+(w*(narrow?.42:.30)-3)*ky(k);
    const Y=(k)=> hz + (h*1.06-hz)*ky(k);
    /* sky + water */
    let g=ctx.createLinearGradient(0,0,0,hz);
    g.addColorStop(0,'#070A09');g.addColorStop(1,'#0E1417');
    ctx.fillStyle=g;ctx.fillRect(0,0,w,hz);
    g=ctx.createLinearGradient(0,hz,0,h);
    g.addColorStop(0,'#0B1013');g.addColorStop(1,'#06090A');
    ctx.fillStyle=g;ctx.fillRect(0,hz,w,h-hz);
    ctx.strokeStyle='rgba(245,246,242,.11)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(0,hz);ctx.lineTo(w,hz);ctx.stroke();
    /* ripples follow the perspective */
    for(let i=1;i<20;i++){
      const k=1-i/20, y=Y(k)+Math.sin(t*.5+i)*1.1;
      ctx.strokeStyle='rgba(245,246,242,'+(0.010+(1-k)*0.035).toFixed(3)+')';
      ctx.beginPath();ctx.moveTo(vx-W(k)*2.6,y);ctx.lineTo(vx+W(k)*2.6,y);ctx.stroke();
    }
    /* navigable corridor */
    if(p>.04){
      const a=clamp((p-.04)/.16,0,1);
      ctx.beginPath();
      for(let k=0;k<=.92;k+=.04) ctx.lineTo(vx-W(k)*.70,Y(k));
      for(let k=.92;k>=0;k-=.04) ctx.lineTo(vx+W(k)*.70,Y(k));
      ctx.closePath();
      ctx.fillStyle='rgba('+SIG+','+(a*.014).toFixed(3)+')';ctx.fill();
      ctx.setLineDash([3,7]);ctx.strokeStyle='rgba('+SIG+','+(a*.34).toFixed(3)+')';ctx.lineWidth=1;ctx.stroke();
      ctx.setLineDash([]);
      if(p>.12) lab(ctx, narrow? w*.05 : vx+W(.12)*.70+10, narrow? Y(.06) : Y(.12),'NAVIGABLE CORRIDOR',clamp((p-.12)/.1,0,1)*.7);
    }
    /* shoreline observations */
    const dens=clamp(.3+p*.7,0,1);
    cloud.forEach(b=>{
      if(b.s>dens) return;
      const k=b.k, near=1-k;
      const edge=W(k), x=vx+b.side*(edge*(1+b.o*.16)), y=Y(k)-b.o*edge*.05;
      const a=(.12+.34*near);
      if(b.v<.055){ ctx.fillStyle='rgba('+SIG+','+(a*1.5).toFixed(3)+')'; ctx.fillRect(x-1,y-1,2.2,2.2); }
      else { ctx.fillStyle='rgba(245,246,242,'+a.toFixed(3)+')';
             const r=clamp(near*2.1+.5,.6,2.4); ctx.fillRect(x,y,r,r); }
      if(b.v>.955){ ctx.strokeStyle='rgba(245,246,242,'+(a*.5).toFixed(3)+')';ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x,y-edge*.10);ctx.stroke(); }
    });
    /* bridge */
    const bk=.40, bw=W(bk), by=Y(bk), deckY=by-bw*.58, dh=bw*.11;
    ctx.strokeStyle='rgba(245,246,242,.40)';ctx.lineWidth=1.4;
    ctx.beginPath();
    ctx.moveTo(vx-bw*1.15,deckY);ctx.lineTo(vx+bw*1.15,deckY);
    ctx.moveTo(vx-bw*1.15,deckY+dh);ctx.lineTo(vx+bw*1.15,deckY+dh);ctx.stroke();
    ctx.strokeStyle='rgba(245,246,242,.26)';ctx.lineWidth=1.2;
    [-1,1].forEach(sg=>{ const x=vx+sg*bw*.72;
      ctx.beginPath();ctx.moveTo(x,deckY+dh);ctx.lineTo(x,by);ctx.stroke();
      ctx.beginPath();ctx.moveTo(x-bw*.05,by);ctx.lineTo(x+bw*.05,by);ctx.stroke(); });
    ctx.beginPath();ctx.moveTo(vx-bw*1.15,deckY);
    ctx.quadraticCurveTo(vx,deckY-bw*.46,vx+bw*1.15,deckY);
    ctx.strokeStyle='rgba(245,246,242,.16)';ctx.lineWidth=1;ctx.stroke();
    if(p>.18){
      const a=clamp((p-.18)/.14,0,1);
      brackets(ctx,vx-bw*1.26,deckY-bw*.50,bw*2.52,bw*.72,a*.85);
      lab(ctx,vx-bw*1.26,deckY-bw*.50-9,'BRIDGE · FIXED SPAN',a*.9);
    }
    /* clearance */
    if(p>.32){
      const a=clamp((p-.32)/.14,0,1), x=vx+bw*.32;
      ctx.strokeStyle='rgba('+SIG+','+(a*.6).toFixed(3)+')';ctx.lineWidth=1;
      ctx.setLineDash([2,4]);
      ctx.beginPath();ctx.moveTo(x,deckY+dh);ctx.lineTo(x,by);ctx.stroke();ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(x-4,deckY+dh+5);ctx.lineTo(x,deckY+dh);ctx.lineTo(x+4,deckY+dh+5);
      ctx.moveTo(x-4,by-5);ctx.lineTo(x,by);ctx.lineTo(x+4,by-5);ctx.stroke();
      lab(ctx,x+9,(deckY+dh+by)/2,'CLEARANCE 5.10 M',a*.95);
    }
    /* target vessel */
    if(p>.44){
      const a=clamp((p-.44)/.16,0,1);
      const vk=.26, vw=W(vk)*.56, vh=vw*.21;
      const vxp=vx-W(vk)*.52+Math.sin(t*.3)*5, vyp=Y(vk)-vh;
      ctx.fillStyle='rgba(5,8,7,.94)';
      ctx.beginPath();
      ctx.moveTo(vxp,vyp+vh);
      ctx.lineTo(vxp+vw*.80,vyp+vh);
      ctx.lineTo(vxp+vw,vyp+vh*.42);
      ctx.lineTo(vxp+vw*.24,vyp+vh*.42);
      ctx.lineTo(vxp+vw*.24,vyp);
      ctx.lineTo(vxp+vw*.06,vyp);
      ctx.lineTo(vxp+vw*.06,vyp+vh*.42);
      ctx.lineTo(vxp,vyp+vh*.42);
      ctx.closePath();ctx.fill();
      ctx.strokeStyle='rgba(245,246,242,.46)';ctx.lineWidth=1.1;ctx.stroke();
      brackets(ctx,vxp-9,vyp-10,vw+18,vh+20,a*.9);
      lab(ctx,vxp-9,vyp-17,'VESSEL · 86 M · 8.4 KM/H',a*.95);
      lab(ctx,vxp-9,vyp+vh+23,'CPA 240 M · PASSING PORT',a*.5,true);
    }
    /* marker */
    if(p>.60&&!narrow){
      const a=clamp((p-.60)/.14,0,1), mk=.20;
      const mx=vx+W(mk)*.80, my=Y(mk);
      ctx.strokeStyle='rgba(245,246,242,.5)';ctx.lineWidth=1.2;
      ctx.beginPath();ctx.moveTo(mx,my);ctx.lineTo(mx,my-20);ctx.stroke();
      ctx.fillStyle='rgba('+SIG+','+(a*.9).toFixed(3)+')';
      ctx.beginPath();ctx.arc(mx,my-23,3,0,6.283);ctx.fill();
      lab(ctx,mx+10,my-22,'MARKER',a*.7);
    }
    /* planned track */
    if(p>.72){
      const a=clamp((p-.72)/.2,0,1);
      ctx.setLineDash([6,9]);ctx.lineDashOffset=-t*14;
      ctx.strokeStyle='rgba('+SIG+','+(a*.55).toFixed(3)+')';ctx.lineWidth=1.3;
      ctx.beginPath();ctx.moveTo(vx-W(0)*.18,h*1.02);
      ctx.quadraticCurveTo(vx+W(.25)*.30,Y(.30),vx+bw*.05,by);ctx.stroke();
      ctx.setLineDash([]);ctx.lineDashOffset=0;
      lab(ctx,vx-W(0)*.18+12,h*.965,'PLANNED TRACK',a*.6);
    }
    /* copy scrim */
    let sc;
    if(narrow){ sc=ctx.createLinearGradient(0,0,0,h*.62);
      sc.addColorStop(0,'rgba(8,11,10,.97)');sc.addColorStop(.72,'rgba(8,11,10,.86)');sc.addColorStop(1,'rgba(8,11,10,0)');
    } else { sc=ctx.createLinearGradient(0,0,w*.52,0);
      sc.addColorStop(0,'rgba(8,11,10,.97)');sc.addColorStop(.5,'rgba(8,11,10,.66)');sc.addColorStop(1,'rgba(8,11,10,0)'); }
    ctx.fillStyle=sc;ctx.fillRect(0,0,w,h);
  },{ambient:true});
})();

/* ============================================================
   5 — NETWORK: one waterway, then a network of them
   ============================================================ */
const net=(function(){
  const cv=$('#netCanvas'); if(!cv) return null;
  const R=rng(4472);
  const lines=[];
  /* trunk: a sinuous corridor across the frame */
  const trunk=[];
  for(let i=0;i<=26;i++){const u=i/26;
    trunk.push({x:.06+u*.88, y:.80-u*.52+Math.sin(u*7.1)*.055+Math.sin(u*2.3)*.03});}
  lines.push({pts:trunk,order:0,th:0});
  /* tributaries */
  function trib(from,i0,dir,gen){
    const p0=from.pts[i0];
    const pts=[{x:p0.x,y:p0.y}];
    let ang=dir*(0.5+R()*0.7)*(gen===1?1:.8), len=(.055+R()*.05)/gen;
    for(let i=1;i<=7;i++){
      ang+=(R()-.5)*.45;
      const prev=pts[i-1];
      pts.push({x:clamp(prev.x+Math.cos(ang-Math.PI/2)*len*(.7+R()*.6),.01,.99),
                y:clamp(prev.y+Math.sin(ang-Math.PI/2)*len*(.7+R()*.6),.03,.97)});
    }
    const ln={pts,order:gen,th:.05+gen*.11+R()*.13};
    lines.push(ln); return ln;
  }
  for(let i=0;i<9;i++){ const t=trib(lines[0],3+i*2+Math.floor(R()*2),R()<.5?-1:1,1);
    if(R()<.8) trib(t,2+Math.floor(R()*3),R()<.5?-1:1,2);
    if(R()<.5) trib(t,4+Math.floor(R()*2),R()<.5?-1:1,2);
  }
  const places=[{u:.10,n:'ROTTERDAM'},{u:.42,n:'DUISBURG'},{u:.68,n:'MAINZ'},{u:.94,n:'BASEL'}];
  const ships=[];
  for(let i=0;i<260;i++) ships.push({l:0,t:R(),v:.02+R()*.05,seed:R()});
  return setup(cv,(S)=>{
    const {ctx,w,h}=S,p=S.p,t=RM?0:S.t;
    ctx.clearRect(0,0,w,h);
    const zoom=lerp(1.14,0.92,ease(clamp(p*1.05,0,1)));
    const cx=w/2,cy=h/2;
    const X=(u)=>cx+((u-0.5)*w)*zoom, Y=(v)=>cy+((v-0.5)*h)*zoom;
    /* graticule */
    const ga=clamp((p-.45)/.3,0,1)*.05;
    if(ga>0.002){ ctx.strokeStyle='rgba(245,246,242,'+ga.toFixed(3)+')';ctx.lineWidth=1;
      for(let i=1;i<8;i++){ctx.beginPath();ctx.moveTo(w*i/8,0);ctx.lineTo(w*i/8,h);ctx.stroke();}
      for(let i=1;i<5;i++){ctx.beginPath();ctx.moveTo(0,h*i/5);ctx.lineTo(w,h*i/5);ctx.stroke();}
    }
    /* waterways */
    lines.forEach((ln,li)=>{
      const known=clamp((p-ln.th)/.26,0,1);
      /* every waterway exists — only the understood part lights up */
      ctx.beginPath();
      ln.pts.forEach((q,i)=> i?ctx.lineTo(X(q.x),Y(q.y)):ctx.moveTo(X(q.x),Y(q.y)));
      ctx.strokeStyle='rgba(245,246,242,.085)';
      ctx.lineWidth=li===0?1.5:(ln.order===1?1.05:.75);ctx.lineCap='round';ctx.stroke();
      if(known<=0 && li>0) return;
      const seg=Math.max(2,Math.round(ln.pts.length*(li===0?clamp(.25+p*1.2,0,1):known)));
      ctx.beginPath();
      for(let i=0;i<seg;i++){const q=ln.pts[i];i?ctx.lineTo(X(q.x),Y(q.y)):ctx.moveTo(X(q.x),Y(q.y));}
      const base=li===0?.38:.16;
      ctx.strokeStyle='rgba(245,246,242,'+(base+known*.22).toFixed(3)+')';
      ctx.lineWidth=li===0?1.6:(ln.order===1?1.1:.8);
      ctx.lineCap='round';ctx.stroke();
      if(known>.30){ ctx.strokeStyle='rgba('+SIG+','+((known-.30)*.26).toFixed(3)+')';
        ctx.lineWidth=(li===0?2.4:1.4);ctx.stroke(); }
    });
    /* vessels */
    const active=Math.min(ships.length,Math.max(1,Math.round(Math.pow(1240,ease(clamp((p-.10)/.80,0,1))))));
    for(let i=0;i<active;i++){
      const s=ships[i];
      const ln=lines[i===0?0:(i%lines.length)];
      const known=i===0?1:clamp((p-ln.th)/.26,0,1);
      if(known<=0) continue;
      s.t+=(RM?0:s.v*0.006); if(s.t>1) s.t-=1;
      const f=s.t*(ln.pts.length-1), i0=Math.floor(f), fr=f-i0;
      const a=ln.pts[i0], b=ln.pts[Math.min(i0+1,ln.pts.length-1)];
      const x=X(lerp(a.x,b.x,fr)), y=Y(lerp(a.y,b.y,fr));
      const al=clamp(.35+known*.5,0,1);
      ctx.fillStyle='rgba('+SIG+','+al.toFixed(3)+')';
      const sz=i<6?1.7:1.1; ctx.fillRect(x-sz,y-sz,sz*2,sz*2);
      if(i<40){ ctx.strokeStyle='rgba('+SIG+',.18)';ctx.lineWidth=i<6?1.4:1;
        ctx.beginPath();ctx.moveTo(X(a.x),Y(a.y));ctx.lineTo(x,y);ctx.stroke(); }
    }
    /* place labels */
    const pa=clamp((p-.58)/.25,0,1);
    if(pa>.01){
      mono(ctx,9.5,400);try{ctx.letterSpacing='.18em';}catch(e){}
      places.forEach(pl=>{
        const i=Math.round(pl.u*(trunk.length-1)), q=trunk[i];
        const x=X(q.x),y=Y(q.y);
        ctx.fillStyle='rgba(245,246,242,'+(pa*.5).toFixed(3)+')';
        ctx.fillText(pl.n,x+9,y-7);
        ctx.strokeStyle='rgba(245,246,242,'+(pa*.25).toFixed(3)+')';ctx.lineWidth=1;
        ctx.beginPath();ctx.arc(x,y,3.2,0,6.283);ctx.stroke();
      });
      try{ctx.letterSpacing='0px';}catch(e){}
    }
    let sc=ctx.createLinearGradient(0,0,0,h);
    sc.addColorStop(0,'rgba(5,7,6,.55)');sc.addColorStop(.45,'rgba(5,7,6,0)');sc.addColorStop(1,'rgba(5,7,6,.55)');
    ctx.fillStyle=sc;ctx.fillRect(0,0,w,h);
    sc=ctx.createLinearGradient(0,0,w*(w<820?1.0:.58),0);
    sc.addColorStop(0,'rgba(5,7,6,.94)');sc.addColorStop(.6,'rgba(5,7,6,.6)');sc.addColorStop(1,'rgba(5,7,6,0)');
    ctx.fillStyle=sc;ctx.fillRect(0,0,w,h);
  },{ambient:true});
})();

/* ============================================================
   6 — WORLD MODEL: a bridge that sharpens with every passage
   ============================================================ */
const wm=(function(){
  const cv=$('#wmCanvas'); if(!cv) return null;
  const R=rng(9091);
  const N=1800, order=[], jit=[];
  for(let i=0;i<N;i++){order.push(i);jit.push({a:R()*6.283,r:R(),k:R()});}
  for(let i=N-1;i>0;i--){const j=Math.floor(R()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
  function target(u,w,h,narrow){
    const x0=w*(narrow?.05:.47), x1=w*(narrow?.95:.93);
    const yd=h*(narrow?.60:.46), dh=h*.028, yw=h*(narrow?.86:.74), ar=h*(narrow?.10:.15);
    if(u<.22){const f=u/.22;return{x:lerp(x0,x1,f),y:yd};}                        /* deck top */
    if(u<.40){const f=(u-.22)/.18;return{x:lerp(x0,x1,f),y:yd+dh};}               /* deck under */
    if(u<.60){const f=(u-.40)/.20;return{x:lerp(x0,x1,f),y:yd-Math.sin(f*Math.PI)*ar};} /* arch */
    if(u<.70){const f=(u-.60)/.10;return{x:lerp(x0,x1,.22),y:lerp(yd+dh,yw,f)};}  /* pier */
    if(u<.80){const f=(u-.70)/.10;return{x:lerp(x0,x1,.78),y:lerp(yd+dh,yw,f)};}  /* pier */
    if(u<.90){const f=(u-.80)/.10;const t=f;                                       /* hangers */
      const hx=lerp(x0,x1,t), ha=yd-Math.sin(t*Math.PI)*ar;
      return{x:hx,y:lerp(ha,yd,(Math.floor(t*90)%9)/9)};}
    const f=(u-.90)/.10;return{x:lerp(0,w,f),y:yw+Math.sin(f*11)*2.2};             /* quay line */
  }
  return setup(cv,(S)=>{
    const {ctx,w,h}=S,p=S.p,narrow=w<820;
    ctx.clearRect(0,0,w,h);
    const shown=Math.round(N*clamp(p*1.3,0,1));
    const sharp=ease(clamp(p*1.2,0,1));
    const jitAmt=(1-sharp)*(1-sharp)*h*.055+h*.0014;
    for(let i=0;i<shown;i++){
      const idx=order[i], u=idx/N, q=target(u,w,h,narrow), j=jit[idx];
      const wob=j.r*jitAmt;
      const x=q.x+Math.cos(j.a)*wob, y=q.y+Math.sin(j.a)*wob*.75;
      const acc=clamp(sharp*1.25-j.k*.22,0,1);
      if(j.k>.93){ ctx.fillStyle='rgba('+SIG+','+(.30+acc*.6).toFixed(3)+')'; ctx.fillRect(x-1,y-1,2.2,2.2); }
      else { ctx.fillStyle='rgba(245,246,242,'+(.12+acc*.52).toFixed(3)+')'; ctx.fillRect(x,y,1.3,1.3); }
    }
    if(p>.55){
      const a=clamp((p-.55)/.34,0,1);
      ctx.setLineDash([3,6]);ctx.lineWidth=1;
      for(let k=0;k<3;k++){
        const y=h*(narrow?.90:.78)+k*h*.035;
        ctx.strokeStyle='rgba('+SIG+','+(a*(.24-k*.06)).toFixed(3)+')';
        ctx.beginPath();ctx.moveTo(0,y+8);
        ctx.quadraticCurveTo(w*.55,y-16-k*7,w,y+2);ctx.stroke();
      }
      ctx.setLineDash([]);
      mono(ctx,9.5,400);try{ctx.letterSpacing='.16em';}catch(e){}
      ctx.fillStyle='rgba(245,246,242,'+(a*.4).toFixed(3)+')';
      if(!narrow) ctx.fillText('OBSERVED TRAFFIC PATTERN',w*.47,h*.86);
      try{ctx.letterSpacing='0px';}catch(e){}
    }
    if(p>.76){
      const a=clamp((p-.76)/.2,0,1);
      mono(ctx,9.5,500);try{ctx.letterSpacing='.16em';}catch(e){}
      const lx=w*(narrow?.05:.48), ly=h*(narrow?.40:.20);
      ctx.strokeStyle='rgba('+SIG+','+(a*.4).toFixed(3)+')';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(lx+2,ly+8);ctx.lineTo(lx+2,h*(narrow?.58:.44));ctx.stroke();
      ctx.fillStyle='rgba('+SIG+','+(a*.85).toFixed(3)+')';
      ctx.fillText('AIR DRAFT 5.10 M',lx+12,ly);
      ctx.fillStyle='rgba(245,246,242,'+(a*.4).toFixed(3)+')';
      ctx.fillText('WATER LEVEL −0.30 M',lx+12,ly+17);
      ctx.fillText('LAST UPDATE 04:12 · 1,284 PASSAGES',lx+12,ly+34);
      try{ctx.letterSpacing='0px';}catch(e){}
    }
    let sc;
    if(narrow){ sc=ctx.createLinearGradient(0,0,0,h*.52);
      sc.addColorStop(0,'rgba(5,7,6,.97)');sc.addColorStop(.75,'rgba(5,7,6,.85)');sc.addColorStop(1,'rgba(5,7,6,0)');
    } else { sc=ctx.createLinearGradient(0,0,w*.56,0);
      sc.addColorStop(0,'rgba(5,7,6,.96)');sc.addColorStop(.6,'rgba(5,7,6,.7)');sc.addColorStop(1,'rgba(5,7,6,0)'); }
    ctx.fillStyle=sc;ctx.fillRect(0,0,w,h);
  });
})();

/* ============================================================
   SCROLL DRIVER
   ============================================================ */
const tracks={
  prob : $('#problem'),
  water: $('#maritime'),
  net  : $('.net'),
  wm   : $('#worldmodel'),
  vis  : $('.vision')
};
const probLines=$$('.prob-lines .ln'), visLines=$$('.vis-lines .ln');
const netHead=$('#netHead'), netCount=$('#netCount');
const wmBar=$('#wmBar'), wmLabel=$('#wmLabel'), wmObs=$('#wmObs');
let netSwapped=false, lastAct=0;
function prog(el){
  if(!el) return 0;
  const r=el.getBoundingClientRect(), span=r.height-window.innerHeight;
  return span<=0?0:clamp(-r.top/span,0,1);
}
function seq(nodes,p){
  const n=nodes.length, idx=clamp(Math.floor(p*n*1.02),0,n-1);
  nodes.forEach((el,i)=>{
    el.classList.toggle('on',i===idx);
    el.classList.toggle('out',i<idx);
  });
}
const nf=v=>v.toLocaleString('en-US');
function frame(){
  const y=window.scrollY||window.pageYOffset;
  nav.classList.toggle('stuck',y>40);
  if(lightSec){
    const r=lightSec.getBoundingClientRect(), on=r.top<=76&&r.bottom>76;
    nav.classList.toggle('light',on); rail.classList.toggle('hide',on);
  }

  seq(probLines,prog(tracks.prob));
  seq(visLines,prog(tracks.vis));

  if(window.__prob){ window.__prob.state.p=prog(tracks.prob); window.__prob.redraw(); }
  if(water) water.state.p=prog(tracks.water);

  if(net){
    const p=prog(tracks.net); net.state.p=p;
    const e=ease(clamp((p-.10)/.80,0,1));
    const v=Math.max(1,Math.round(Math.pow(1240,e)));
    netCount.textContent='VESSELS ONLINE · '+String(v).padStart(4,'0');
    const want=p>.52;
    if(want!==netSwapped){
      netSwapped=want;
      netHead.style.transition='opacity .35s ease';
      netHead.style.opacity=0;
      setTimeout(()=>{ netHead.textContent = want ? 'A thousand vessels understand it.' : 'One vessel sees a waterway.';
        netHead.style.opacity=1; },340);
    }
  }
  if(wm){
    const p=prog(tracks.wm); wm.state.p=p; wm.redraw();
    wmBar.style.width=(p*100).toFixed(1)+'%';
    wmLabel.textContent='Passage '+String(Math.max(1,Math.round(p*1284))).padStart(4,'0');
    wmObs.textContent=nf(Math.round(p*p*486000))+' obs';
  }
  /* rail */
  const mid=window.innerHeight*.5; let act=-1;
  railSecs.forEach((s,i)=>{ const r=s.getBoundingClientRect(); if(r.top<=mid&&r.bottom>=mid) act=i; });
  if(act<0) act=lastAct; else lastAct=act;
  railTicks.forEach((b,i)=>b.classList.toggle('act',i===act));
  if(readout.textContent!==railSecs[act].dataset.rail) readout.textContent=railSecs[act].dataset.rail;
}
/* ============================================================
   Contact — compose a pre-filled message
   ============================================================ */
(function(){
  const form=$('#contactForm'); if(!form) return;
  const st=$('#formStatus'), btn=$('#sendBtn');
  const F=id=>$('#f-'+id);
  const baseNote='This opens a pre-filled message in your mail app. Nothing is sent from this page.';
  function setStatus(msg,kind){ st.textContent=msg; st.classList.remove('ok','bad'); if(kind) st.classList.add(kind); }
  function markErr(el,bad){ el.closest('.field').classList.toggle('err',bad); }
  ['name','email','msg'].forEach(k=>F(k).addEventListener('input',()=>{
    markErr(F(k),false); if(st.classList.contains('bad')) setStatus(baseNote);
  }));
  $$('.paths .path').forEach(b=>b.addEventListener('click',()=>{
    const v=b.dataset.interest;
    const sel=F('interest');
    Array.from(sel.options).forEach(o=>{ if(o.text===v) sel.value=o.value; });
    form.scrollIntoView({behavior:RM?'auto':'smooth',block:'center'});
    setTimeout(()=>F('name').focus({preventScroll:true}),RM?0:500);
  }));
  btn.addEventListener('click',()=>{
    const name=F('name').value.trim(), email=F('email').value.trim(), msg=F('msg').value.trim();
    const bad=[];
    if(!name){markErr(F('name'),true);bad.push('your name');}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){markErr(F('email'),true);bad.push('a valid email');}
    if(msg.length<10){markErr(F('msg'),true);bad.push('a line about what you need');}
    if(bad.length){ setStatus('Add '+bad.join(', ')+' and try again.','bad'); return; }
    const interest=F('interest').value, org=F('org').value.trim(), fleet=F('fleet').value.trim();
    const body=[
      'Name: '+name,
      org?('Organisation: '+org):null,
      'Email: '+email,
      'Role: '+interest,
      fleet?('Vessels in fleet: '+fleet):null,
      '','---','',msg
    ].filter(Boolean).join('\n');
    window.location.href='mailto:hello@cornu.ai'
      +'?subject='+encodeURIComponent('Cornu — '+interest+(org?(' · '+org):''))
      +'&body='+encodeURIComponent(body);
    setStatus('Opening your mail app. If nothing happens, write to hello@cornu.ai.','ok');
  });
})();

let ticking=false;
function onScroll(){ if(ticking) return; ticking=true;
  requestAnimationFrame(()=>{ frame(); ticking=false; }); }
window.addEventListener('scroll',onScroll,{passive:true});
window.addEventListener('resize',onScroll,{passive:true});
setTimeout(frame,60); setTimeout(frame,900);
})();
