import test from 'node:test';
import assert from 'node:assert/strict';
import {selectPair,coverage,tileIndex,Metrics,percentile} from '../web/render-health.mjs';
const image=(id,scale,complete=true)=>({id,camera:[0,0,scale],geometry:[128,128,16,16],texture:{width:160,height:160},nextTile:9,totalTiles:9,complete,completedAt:0,lastBatchAt:0});
const fits=(i,c,w,h,max=Infinity)=>Math.abs(c[0]-i.camera[0])/i.camera[2]+w/h*c[2]/i.camera[2]<=i.texture.width/i.geometry[1]&&Math.abs(c[1]-i.camera[1])/i.camera[2]+c[2]/i.camera[2]<=i.texture.height/i.geometry[1]&&h/(i.geometry[1]*c[2]/i.camera[2])<=max;
const select=overrides=>selectPair({base:image(1,10),detail:undefined,since:0,images:[],jobs:[],camera:[0,0,1],width:128,height:128,now:1000,fadeMs:140,fits,...overrides});
test('cancelled partial detail cannot keep screen stuck',()=>{const orphan=image(2,1,false),fresh=image(3,1);const s=select({detail:orphan,images:[orphan,fresh]});assert.equal(s.detail,fresh);});
test('retired partial cache entries are never selected for new detail',()=>{assert.equal(select({images:[image(2,1,false)]}).detail,undefined);});
test('huge zoom jump replaces stale pending detail with fresh work',()=>{const old=image(2,100,false),fresh=image(3,1,false);assert.equal(select({base:image(1,1000),detail:old,jobs:[old,fresh]}).detail,fresh);});
test('complete detail promotes only after fade and full coverage',()=>{const d=image(2,1);assert.equal(select({detail:d,images:[d]}).base,d);assert.equal(select({detail:d,images:[d],since:990}).detail,d);});
test('in-progress detail never promotes as complete',()=>{const d=image(2,1,false);assert.notEqual(select({detail:d,jobs:[d]}).base,d);});
test('coverage detects enlarged pixels despite full image coverage',()=>{const c=coverage([image(1,10)],[0,0,1],128,128,1000,140,0);assert.equal(c.coverage,1);assert.equal(c.sharpCoverage,0);assert.equal(c.maxMagnification,10);});
test('fresh completed viewport is sharply covered',()=>assert.equal(coverage([image(1,1)],[0,0,1],128,128,1000,140,0).sharpCoverage,1));
test('tile order covers irregular padded rectangles without holes',()=>{for(const [w,h,p] of [[129,97,17],[1600,1151,200],[64,64,0]]){const i={geometry:[w,h,p,p],texture:{width:w+2*p,height:h+2*p}};const gx=Math.ceil(i.texture.width/64),gy=Math.ceil(i.texture.height/64),ids=[];for(let y=0;y<gy;y++)for(let x=0;x<gx;x++)ids.push(tileIndex(x,y,i));assert.deepEqual(ids.sort((a,b)=>a-b),Array.from({length:gx*gy},(_,n)=>n));}});
test('metrics retention bounded and percentiles handle empty input',()=>{const m=new Metrics(2);for(let n=0;n<5;n++)m.sample({time:n,queueMs:n,frameGapMs:16,layers:2,textureBytes:0,sharpCoverage:1,cacheHit:true});const s=m.snapshot();assert.equal(s.samples,2);assert.equal(s.dropped,3);assert.deepEqual(s.frames.map(x=>x.time),[3,4]);assert.equal(s.summary.queueMsP95,4);assert.equal(percentile([],.95),null);});

test('a panned partial detail yields to a completed covering view',()=>{
  const base=image(1,10), old=image(2,1), fresh=image(3,1);
  old.camera[0]=1;
  const s=select({base,detail:old,images:[base,old,fresh]});
  assert.equal(s.detail,fresh);
});
