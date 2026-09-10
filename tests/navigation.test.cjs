// Run with: node --test tests/navigation.test.cjs
// SIM_ROOT=source/simulation tests authoring files; default tests the published bundle.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function simulation(id) {
  global.window=global;global.document={getElementById:()=>null};global.addEventListener=()=>{};
  const root=process.env.SIM_ROOT||'docs/simulation';
  for(const f of ['00-config','01-math','10-world','20-sensors','30-tracking','35-navigation','40-worldmodel','70-main'])
    vm.runInThisContext(fs.readFileSync(path.join(root,'assets/js',f+'.js'),'utf8'),{filename:f+'.js'});
  const NS=global.CORNU;
  const app=Object.create(NS.App.prototype);app.renderer={selectedId:null};app.loadScenario(id);
  return {NS,app};
}
const scenarios=process.env.SIM_SCENARIO?[process.env.SIM_SCENARIO]:['normal','collision','obstacle','occlusion','sensorfail','bridge'];
for(const scenario of scenarios)test(scenario+': full hull clears contacts and banks and passes the bridge',()=>{
  const {NS,app}=simulation(scenario);let maxStation=0,minBank=Infinity,loops=0,prev=app.world;
  const duration=Number(process.env.SIM_DURATION||660),dt=Number(process.env.SIM_STEP||.1);
  for(let t=0;t<duration;t+=dt){
    app.stepSim(dt);
    if(app.world!==prev){loops++;prev=app.world;}
    const world=app.world,own=world.ownShip,poly=own.footprint();maxStation=Math.max(maxStation,own.stationEstimate);
    for(const e of world.entities){
      assert.ok(!NS.math.polysOverlap(poly,e.footprint()),scenario+' contact with '+e.id+' at '+t.toFixed(1)+'s / station '+own.stationEstimate.toFixed(1));
    }
    for(const p of poly){const a=app.wm.chart.project(p),clear=app.wm.chart.at(a.s).halfWidth-Math.abs(a.offset);minBank=Math.min(minBank,clear);assert.ok(clear>=0,scenario+' bank contact at '+t.toFixed(1)+'s');}
    if(process.env.SIM_VERBOSE && Math.floor(t/dt)%600===0)console.log(scenario,t.toFixed(0),own.stationEstimate.toFixed(0),own.speed.toFixed(2),app.wm.guidance.targetOffset);
  }
  console.log(JSON.stringify({scenario,maxStation:Math.round(maxStation),minBank:Math.round(minBank*10)/10,loops}));
  assert.ok(maxStation>1250,'Vessel must progress beyond the bridge, reached '+Math.round(maxStation));
});
test('blocked bridge commands a stop before the bow reaches the structure',()=>{
  const {app}=simulation('bridge');app.world.bridge.clearance=4;
  for(let t=0;t<300;t+=.1)app.stepSim(.1);
  assert.ok(app.world.ownShip.stationEstimate<1060);
  assert.ok(app.world.ownShip.speed<.1);
});

test('route loop and scenario reset discard old guidance and observations',()=>{
  const {app}=simulation('normal'),oldWorld=app.world,oldModel=app.wm;
  oldWorld.ownShip.position=oldWorld.waterway.point(oldWorld.waterway.length-80,22);
  app.stepSim(.1);
  assert.notEqual(app.world,oldWorld);
  assert.notEqual(app.wm,oldModel);
  assert.ok(app.world.ownShip.stationEstimate<100);
  assert.ok(app.simTime<2);
  assert.equal(app._restartPending,false);
  app.loadScenario('obstacle');
  assert.equal(app.scenarioId,'obstacle');
  assert.ok(app.recentObs.every(o=>o.timestamp<=app.simTime));
});
