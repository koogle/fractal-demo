// Compare the real WASM planner against the pre-migration JS policy in git.
// Run after make build. Does not require a browser or GPU.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {RenderPlanner} from '../web/render-plan.mjs';
const source=execFileSync('git',['show','5e71a6e:web/render-health.mjs'],{encoding:'utf8'});
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
  checks++;
 }
}
console.log(`${checks} seeded selection/priority comparisons and ${checks*16} coverage comparisons passed.`);
