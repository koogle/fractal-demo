// Validate actual WASM exports, without a DOM or GPU. Run after make build.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RenderPlanner} from '../web/render-plan.mjs';
const {instance}=await WebAssembly.instantiate(readFileSync(new URL('../web/fractal.wasm',import.meta.url)),{});
const r=instance.exports, read=(ptr,n)=>Array.from(new Float64Array(r.memory.buffer,ptr,n));
let seed=20261002;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
assert.deepEqual(read(r.render_config(128*2**20,256*2**20,65535),7),[2**30,8,48,1023,1023*32768,128,140]);
let uniformChecks=0;
for(let i=0;i<2000;i++){
 const width=1+Math.floor(random()*2000),height=1+Math.floor(random()*1300),extent=1.25;
 const px=Math.ceil(width*(extent-1)/2),py=Math.ceil(height*(extent-1)/2),w=width+2*px,h=height+2*py,tiles=Math.ceil(w/64)*Math.ceil(h/64);
 assert.deepEqual(read(r.job_geometry(width,height,extent),7),[w,h,px,py,w*h*8,tiles,tiles*4]);
 const dpr=.5+random()*3,scale=Math.min(dpr,1.5,1600/Math.max(width,height));
 assert.deepEqual(read(r.render_size(width,height,dpr,8192),2),[Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale))]);
 // Random integer payload includes NaNs as f32: untouched words must survive exactly.
 const expected=Uint32Array.from({length:24},()=>Math.floor(random()*2**32));
 new Uint32Array(r.memory.buffer,r.compute_input_ptr(),24).set(expected);
 const f=new Float32Array(expected.buffer),next=Math.floor(random()*tiles),reference=12,seconds=random()*1e4;
 f.set([w,h,next,reference],0);f.set([px,py,width,height],16);f[23]=seconds;
 const pointer=r.compute_frame(w,h,next,reference,px,py,width,height,seconds);
 assert.deepEqual(new Uint32Array(r.memory.buffer,pointer,24),expected);uniformChecks++;
}
r.reset_view();r.update_frame(1600,900,0);
assert.equal(r.render_settings_changed(1600,900),1);assert.equal(r.render_settings_changed(1600,900),0);
r.set_color_density(.1);r.update_frame(1600,900,1);assert.equal(r.render_settings_changed(1600,900),0);
r.set_iterations(512);r.update_frame(1600,900,2);assert.equal(r.render_settings_changed(1600,900),1);
r.render_invalidate();assert.equal(r.render_settings_changed(1600,900),1);
const planner=new RenderPlanner(r);
const image=(id,next,total,complete=false)=>({id,camera:[0,0,1],geometry:[100,100,13,13],texture:{width:126,height:126},nextTile:next,totalTiles:total,bytes:127008,used:0,complete});
let images=[image(1,4,4,true)],jobs=[image(2,4,4),image(3,2,4),image(4,0,4)];
planner.load(images,jobs,[0,0,1],100,100,0);
assert.equal(r.planner_bytes(0),4*127008);assert.equal(r.planner_bytes(1),3*127008);
assert.deepEqual(planner.completed().map(i=>i.id),[2]);
assert.equal(r.planner_retirement(3),2);assert.equal(r.planner_retirement(4),1);
planner.select(images,jobs,140);assert.equal(r.planner_retirement(1),0);
assert.equal(r.planner_batch_size(100,3,4),1);
// Allocation must include active jobs and preserve the selected base.
let allocation=planner.allocation(images,jobs,127008,4*127008,48,images[0]);
assert.equal(allocation.allowed,false);assert.deepEqual(allocation.evicted,[]);
const disposable=image(5,4,4,true);images.push(disposable);
allocation=planner.allocation(images,jobs,127008,5*127008,48,images[0]);
assert.equal(allocation.allowed,true);assert.deepEqual(allocation.evicted.map(i=>i.id),[5]);
// Browser wheel units and pan mode match the original formulas.
const sceneFrame=()=>Array.from(new Float32Array(r.memory.buffer,r.scene3d_frame(1000,700,1,0),24));
for(const mode of [0,1,2])for(const pinch of [0,1])for(const shift of [0,1]){
 const dx=3,dy=-7,h=900,unit=mode===1?16:mode===2?h:1;
 r.scene3d_reset();r.scene3d_wheel(dx,dy,mode,shift,pinch,h);const actual=sceneFrame();
 r.scene3d_reset();
 if(shift&&!pinch)r.scene3d_pan(dx*unit/h,0);
 else r.scene3d_zoom(Math.exp(Math.max(-.3,Math.min(.3,dy*unit*(pinch?.008:.002)))));
 assert.deepEqual(actual,sceneFrame());
 r.reset_view();r.navigation_wheel(dy,mode,pinch,300,400,1600,h);
 // camera_ptr updates on frame preparation, so prepare both sides before comparing.
 r.update_frame(1600,h,0);const actual2=Array.from(new Float64Array(r.memory.buffer,r.camera_ptr(),3));
 r.reset_view();r.zoom_at(Math.exp(Math.max(-.5,Math.min(.5,dy*unit*(pinch?.01:.002)))),(600-1600)/h,(h-800)/h);
 r.update_frame(1600,h,0);assert.deepEqual(actual2,Array.from(new Float64Array(r.memory.buffer,r.camera_ptr(),3)));
}
// Compare 3D refresh decisions to the former JS state machine, including input
// arriving during GPU work, pause/resume, dragging, resize and slow completions.
let revision=0,rendered=-1,lastInput=-Infinity,full=false,resolution=720,light=true;
for(let i=0;i<2000;i++){
 const now=i*37;
 if(random()<.35){r.scene3d_invalidate(now);revision++;lastInput=now;}
 if(random()<.08){light=!light;r.scene3d_light(Number(light));r.scene3d_invalidate(now);revision++;lastInput=now;}
 if(random()<.03){r.scene3d_resume();full=false;rendered=-1;}
 const dragging=random()<.1,moving=dragging||now-lastInput<160,needed=light||rendered!==revision||(!full&&!moving);
 const limit=moving?resolution:light?1000:1400,scale=Math.min(2,limit/1600);
 assert.deepEqual(read(r.scene3d_plan(now,Number(dragging),1600,900,2,8192),4),[Number(needed),Math.round(1600*scale),Math.round(900*scale),Number(moving)]);
 if(!needed)continue;
 const submitted=revision,elapsed=1+random()*100;
 if(random()<.2){r.scene3d_invalidate(now+1);revision++;lastInput=now+1;}
 if(moving)resolution=Math.max(400,Math.min(960,resolution*Math.max(.8,Math.min(1.1,Math.sqrt(20/Math.max(1,elapsed))))));
 rendered=submitted;full=!moving;
 assert.equal(r.scene3d_finish(elapsed),revision!==rendered?0:light?16:!full?180:-1);
}
// Light advances during zoom and freezes while paused. Dolly collision stops
// repeated large inward requests outside the center; backing out still works.
r.scene3d_reset();r.scene3d_light(1);
const frame=(t)=>Array.from(new Float32Array(r.memory.buffer,r.scene3d_frame(1000,700,1,t),28));
const a=frame(0);for(let i=0;i<80;i++)r.scene3d_zoom(.1);const b=frame(1);
assert.ok(b[19]>=.02);assert.ok(Math.hypot(...b.slice(0,3))>.1);assert.notDeepEqual(a.slice(24,27),b.slice(24,27));
r.scene3d_zoom(2);const c=frame(2);assert.ok(c[19]>b[19]);
r.scene3d_light(0);const d=frame(3),e=frame(4);assert.deepEqual(d.slice(24,27),e.slice(24,27));
console.log(`${uniformChecks} geometry/viewport/bit-exact uniform cases, 2000 3D refresh cases, lifecycle, invalidation, light and collision checks passed.`);
