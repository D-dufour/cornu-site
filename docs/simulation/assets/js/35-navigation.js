/* Route planning for the demonstration. Uses chart geometry, ego state and
   estimated tracks only. Ground-truth contacts are reserved for validation. */
(function (NS) {
  'use strict';
  const {clamp, wrapPi, fwd, rectCorners, polysOverlap} = NS.math;
  const C = NS.CFG.ownShip;

  function Chart(stations) {
    this.stations = stations;
    this.length = stations[stations.length - 1].s;
  }
  Chart.prototype.at = NS.world.Waterway.prototype.at;
  Chart.prototype.point = NS.world.Waterway.prototype.point;
  Chart.prototype.project = function (p) {
    let s = clamp(p.y, 0, this.length);
    for (let i = 0; i < 3; i++) {
      const a = this.at(s);
      s = clamp(s + ((p.x-a.p.x)*a.tangent.x + (p.y-a.p.y)*a.tangent.y)*a.tangent.y, 0, this.length);
    }
    const a = this.at(s);
    return {s, offset: -(p.x-a.p.x)*a.normal.x-(p.y-a.p.y)*a.normal.y};
  };

  /* The planner rolls out the same helm and engine that the hull executes.
     Orders are absolute chart offsets, never corrections from a moving bow. */
  function advance(ship, chart, offset, speedFactor, dt) {
    const here = chart.project(ship.position);
    let bound = Infinity;
    for (const ahead of [-C.length/2, 0, C.length/2, C.lookahead]) {
      bound = Math.min(bound, chart.at(here.s+ahead).halfWidth-C.beam/2-NS.CFG.navigation.bankMargin);
    }
    offset = clamp(offset, -bound, bound);
    ship.commandedOffset += (offset-ship.commandedOffset)*clamp(dt*2.4,0,1);
    const cross = ship.commandedOffset-here.offset;
    const urgency = clamp(Math.abs(cross)/20,0,1);
    const look = C.lookahead*(1-urgency*0.62);
    const target = chart.point(here.s+look,ship.commandedOffset);
    const desired = Math.atan2(target.x-ship.position.x,target.y-ship.position.y);
    const maxYaw = C.maxYawRate*(1+urgency*.85);
    const demand = clamp(wrapPi(desired-ship.heading)*C.helmGain*(1+urgency*.6),-maxYaw,maxYaw);
    ship.yawRate += (demand-ship.yawRate)*clamp(dt*C.helmDamping,0,1);
    // Rudder authority falls with speed; stopped hulls do not spin in place.
    ship.heading = wrapPi(ship.heading+ship.yawRate*clamp(ship.speed/1.5,0,1)*dt);
    ship.speed += clamp(C.cruiseSpeed*speedFactor-ship.speed,-NS.CFG.navigation.deceleration*dt,NS.CFG.navigation.acceleration*dt);
    const F=fwd(ship.heading);
    ship.position={x:ship.position.x+F.x*ship.speed*dt,y:ship.position.y+F.y*ship.speed*dt,z:0};
    ship.stationEstimate=here.s;
  }

  function plan(wm, dt) {
    const own=wm.ownVessel, G=wm.guidance, chart=wm.chart, cfg=NS.CFG.navigation;
    if (!own || !chart) return;
    wm._planElapsed=(wm._planElapsed||0)+dt;
    if (wm._planElapsed<cfg.replanPeriod && G.targetOffset!==undefined) return;
    wm._planElapsed=0;
    const here=chart.project(own.position), previous=G.targetOffset===undefined?C.laneOffset:G.targetOffset;
    const bridge=wm.bridgeEst.state;
    let span=null;
    if(bridge && bridge.confidence>.35) {
      const bp=NS.math.port(bridge.heading);
      const opening=chart.project({x:bridge.position.x-bp.x*bridge.openingOffset,y:bridge.position.y-bp.y*bridge.openingOffset});
      if(opening.s>here.s-C.length && opening.s<here.s+cfg.horizon*C.cruiseSpeed+C.length) span={...opening,half:Math.max(0,(bridge.openingWidth-7)/2),passable:bridge.passable!==false,id:bridge.id};
    }
    const tracks=wm.entities.filter(e=>e.confidence>.22).map(e=>{
      const p=chart.project(e.position), a=chart.at(p.s);
      const speed=clamp(e.velocity.x*a.tangent.x+e.velocity.y*a.tangent.y,-7,7);
      const moving=Math.abs(speed)>.65 && !['buoy','bridge_pillar'].includes(e.semanticClass);
      return {e,s:p.s,offset:p.offset,speed:moving?speed:0,sigma:clamp(e.positionUncertainty,1,5)};
    }).filter(e=>e.s>here.s-160 && e.s<here.s+850);
    // Prepare each time slice once; every candidate sees the same predictions.
    const slices=[];
    for(let t=cfg.sampleStep;t<=cfg.horizon;t+=cfg.sampleStep){
      slices.push({t,contacts:tracks.map(q=>{
        const s=clamp(q.s+q.speed*chart.at(q.s).tangent.y*t,0,chart.length);
        const p=q.speed?chart.point(s,q.offset):q.e.position;
        const h=q.speed?chart.at(s).heading+(q.speed<0?Math.PI:0):q.e.heading;
        const margin=(q.e.semanticClass==='bridge_pillar'?cfg.bridgeMargin:cfg.contactMargin)+q.sigma;
        return {id:q.e.id,s,offset:q.offset,poly:rectCorners(p,h,q.e.dimensions.length+margin*2,q.e.dimensions.beam+margin*2),length:q.e.dimensions.length};
      })});
    }
    const offsets=[C.laneOffset,previous,here.offset];
    for(let off=-38;off<=38;off+=6) offsets.push(off);
    if(span) offsets.push(span.offset);
    let best=null, nominal=null;
    const evaluate=(offset,factor)=>{
      const ship={position:{...own.position},heading:own.heading,speed:own.speed,yawRate:own.yawRate,commandedOffset:previous};
      let penalty=0,firstHit=null,minGap=Infinity;
      const path=[];
      for(const slice of slices){
        for(let j=0;j<cfg.sampleStep/.5;j++) advance(ship,chart,offset,factor,.5);
        const p=chart.project(ship.position);
        const poly=rectCorners(ship.position,ship.heading,C.length,C.beam);
        let blocked=false;
        for(const corner of poly){const cp=chart.project(corner);if(Math.abs(cp.offset)>chart.at(cp.s).halfWidth-cfg.bankMargin){blocked=true;break;}}
        if(span && Math.abs(p.s-span.s)<C.length/2+12){
          if(!span.passable || poly.some(c=>Math.abs(chart.project(c).offset-span.offset)>span.half-cfg.bridgeMargin)) blocked=true;
        }
        let target=blocked?(span?span.id:'bank'):null;
        for(const q of slice.contacts){
          if(Math.abs(q.s-p.s)>(C.length+q.length)/2+25) continue;
          if(polysOverlap(poly,q.poly)){blocked=true;target=q.id;}
          minGap=Math.min(minGap,Math.abs(p.offset-q.offset));
        }
        path.push({t:slice.t,centre:{...ship.position},heading:ship.heading,beam:C.beam});
        if(blocked){penalty=100000+(cfg.horizon-slice.t)*1000;firstHit=target;break;}
        // The demo restarts here; predicting past its endpoint invents a dead end.
        if(p.s>chart.length-90) break;
      }
      const progress=chart.project(ship.position).s-here.s;
      const preferred=span && span.s-here.s<330?span.offset:C.laneOffset;
      const cost=penalty+Math.abs(offset-preferred)*.6+Math.abs(offset-previous)*.9+(1-factor)*55-progress*.13+(minGap<25?(25-minGap)*.3:0);
      return {offset,factor,cost,penalty,firstHit,path};
    };
    const candidates=[...new Set(offsets.map(x=>Math.round(x*10)/10))];
    for(const factor of [1,.55,0]){
      for(const offset of candidates){
        const result=evaluate(offset,factor);
        if(offset===C.laneOffset && factor===1) nominal=result;
        if(!best||result.cost<best.cost) best=result;
      }
      if(best.penalty===0 && factor===1)break;
    }
    G.targetOffset=best.offset;
    G.lateralDemand=C.laneOffset-best.offset;
    G.speedFactor=best.penalty?0:best.factor;
    G.active=Math.abs(G.lateralDemand)>2.5||G.speedFactor<.95;
    G.bridgeLock=!!span && span.s-here.s<330;
    G.reason=G.speedFactor===0?'constrained':G.bridgeLock?'bridge':Math.abs(best.offset-C.laneOffset)>3?'avoiding':'lane';
    G.grade=G.reason;G.level=G.speedFactor===0?'high':G.active?'medium':'none';
    G.targetId=G.bridgeLock?span.id:(nominal && nominal.firstHit)||best.firstHit;
    G.phase=G.active?'approach':'idle';
    G.path=best.penalty?evaluate(best.offset,0).path:best.path;
    // This is the commanded route; risk prediction remains an independent estimate.
    G.aimPoint=chart.point(here.s+C.lookahead,best.offset);
  }
  NS.navigation={Chart,advance,plan};
})(window.CORNU);
