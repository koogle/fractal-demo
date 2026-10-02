// Compare the real WASM planner against the pre-migration JS policy in git.
// Run after make build. Does not require a browser or GPU.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {RenderPlanner} from '../web/render-plan.mjs';
let source=execFileSync('git',['show','5e71a6e:web/render-health.mjs'],{encoding:'utf8'});
// The historical oracle predates the intentional zoom-out overlap fix. Apply
// that single documented rule so this checks the current policy, not a rollback.
const oldPromotion='detail?.complete && fits(detail, camera, width, height)';
assert.ok(source.includes(oldPromotion));
source=source.replace(oldPromotion,'detail?.complete && (fits(detail, camera, width, height) || (base && pitch(detail)>pitch(base) && !fits(base,camera,width,height)))');
const {selectPair}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const {instance}=await WebAssembly.instantiate(readFileSync(new URL('../web/fractal.wasm',import.meta.url)),{});
const planner=new RenderPlanner(instance.exports);
let seed=20261002;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const fits=(i,c,w,h,max=Infinity)=>{
 const r=c[2]/i.camera[2];return Math.abs(c[0]-i.camera[0])/i.camera[2]+w/h*r<=i.texture.width/i.geometry[1]&&Math.abs(c[1]-i.camera[1])/i.camera[2]+r<=i.texture.height/i.geometry[1]&&h/(i.geometry[1]*r)<=max;
};
let checks=0;
for(let scenario=0;scenario<200;scenario++){
 planner.reset();let pair={base:undefined,detail:undefined,since:0};
 const resources=Array.from({length:16},(_,n)=>({id:n+1,camera:[(random()-.5)*2,(random()-.5)*2,2**(random()*6-3)],geometry:[1600,900,200,113],texture:{width:2000,height:1126},complete:n<8,nextTile:Math.floor(random()*100)+1,totalTiles:576,bytes:18016000,used:n,completedAt:0}));
 for(let step=0;step<30;step++){
  const images=resources.filter(i=>i.complete),jobs=resources.filter(i=>!i.complete);
  const camera=[(random()-.5)*2,(random()-.5)*2,2**(random()*6-3)],now=step*80;
  const priority=i=>(fits(i,camera,1600,900,1.25)?0:10)+Math.abs(Math.log(i.camera[2]/camera[2]))-i.nextTile/i.totalTiles;
  jobs.sort((a,b)=>priority(a)-priority(b));
  pair=selectPair({...pair,images,jobs,camera,width:1600,height:900,now,fadeMs:140,fits});
  const urgent=pair.detail??pair.base;
  if(jobs.includes(urgent)&&fits(urgent,camera,1600,900,1.05)){jobs.splice(jobs.indexOf(urgent),1);jobs.unshift(urgent);}
  planner.cached(images,camera,1600,900,now);
  const actual=planner.select(images,resources.filter(i=>!i.complete),140);
  assert.deepEqual([actual.base?.id,actual.detail?.id,actual.since,actual.jobs.map(i=>i.id)],[pair.base?.id,pair.detail?.id,pair.since,jobs.map(i=>i.id)],`scenario ${scenario}, frame ${step}`);
  for(const i of resources)assert.equal(planner.fits(i,camera,1600,900,1.05),fits(i,camera,1600,900,1.05));
  for(const [layer,image] of [actual.base,actual.detail].filter(Boolean).entries()){
    const transform=[(camera[0]-image.camera[0])/image.camera[2],-(camera[1]-image.camera[1])/image.camera[2],camera[2]/image.camera[2]];
    const base=actual.base,ratio=camera[2]/base.camera[2];
    const shift=[(camera[0]-base.camera[0])/base.camera[2],-(camera[1]-base.camera[1])/base.camera[2]];
    const bounds=[-1,1].flatMap(sign=>[
      ((sign*base.texture.width/base.geometry[1]-shift[0])/ratio*900+1600)/2,
      ((sign*base.texture.height/base.geometry[1]-shift[1])/ratio*900+900)/2]);
    const expected=new Float32Array([...transform,1,now/1000,pair.since/1000,layer?0.14:0,0,1600,900,1600,900,...bounds]);
    assert.deepEqual(planner.reprojection(image,layer,140),expected);
  }
  const {targets}=planner.targets(camera,now,step%2,[.2,-.1],.7,8);
  const oldJobs=resources.filter(i=>!i.complete);
  const retired=oldJobs.filter(i=>i!==pair.base&&i!==pair.detail&&!targets.some(c=>fits(i,c,1600,900,1.25)));
  const kept=oldJobs.filter(i=>!retired.includes(i));const requests=[];const simulated=[...images,...kept];let jobCount=kept.length;
  for(const [index,target] of targets.entries()){
    if(simulated.some(i=>fits(i,target,1600,900,1.05)))continue;
    if(jobCount>=8)break;
    requests.push({index,camera:target});jobCount++;
    simulated.push({camera:target,geometry:[1600,900],texture:{width:2000,height:1126}});
  }
  const scheduled=planner.schedule(images,oldJobs,8,1.25);
  assert.deepEqual(scheduled.retired.map(i=>i.id),retired.map(i=>i.id));
  assert.deepEqual(scheduled.requests,requests);
  const protectedImage=images[0],budget=18016000*5;
  let bytes=images.reduce((sum,i)=>sum+i.bytes,0),count=images.length;const evicted=[];
  for(const i of images.filter(i=>i!==pair.base&&i!==pair.detail&&i!==protectedImage).sort((a,b)=>a.used-b.used)){
    if(bytes<=budget&&count<=4)break;evicted.push(i.id);bytes-=i.bytes;count--;
  }
  assert.deepEqual(planner.evictions(images,0,budget,4,protectedImage).map(i=>i.id),evicted);
  checks++;
 }
}
console.log(`${checks} seeded selection, priority, scheduling, eviction, and reprojection comparisons and ${checks*16} coverage comparisons passed.`);
