export function selectPair({base, detail, since, images, jobs, camera, width, height, now, fadeMs, fits}) {
  const pitch = image => image.camera[2] / image.geometry[1];
  const current = camera[2] / height;
  const available = [...images.filter(image => image.complete), ...jobs];
  const intersects = image => {
    const ratio = camera[2] / image.camera[2];
    return Math.abs((camera[0] - image.camera[0]) / image.camera[2]) < image.texture.width / image.geometry[1] + width / height * ratio &&
      Math.abs((camera[1] - image.camera[1]) / image.camera[2]) < image.texture.height / image.geometry[1] + ratio;
  };
  const score = image => Math.abs(Math.log(pitch(image) / current)) + (fits(image, camera, width, height) ? 0 : 1) + (image.complete ? 0 : 0.15);
  const covering = available.filter(image => image.complete && fits(image, camera, width, height));
  if (!base) base = covering.sort((a,b) => score(a)-score(b))[0] ?? jobs[0];
  // A cancelled partial texture cannot finish. Never lock the display onto it.
  if (detail && (!available.includes(detail) || !intersects(detail))) detail = undefined;
  const better = available.filter(image => image !== base && intersects(image)).sort((a,b) => score(a)-score(b) || a.id-b.id);
  if (detail && pitch(detail) / current > 1.5 && better.some(image => pitch(image) < pitch(detail) * 0.8)) detail = undefined;
  if (detail?.complete && fits(detail, camera, width, height) && now-Math.max(since, detail.completedAt) >= fadeMs) {
    base = detail; detail = undefined;
  }
  if (detail && now-since > fadeMs && covering.some(image => image !== base && fits(image,camera,width,height,1.05)) && !fits(detail,camera,width,height)) detail = undefined;
  if (!detail && base) {
    const basePitch = pitch(base);
    const next = better.find(image => image !== base &&
      (pitch(image) < basePitch * 0.92 || !fits(base,camera,width,height) ||
        (basePitch < current * 0.65 && score(image)+0.15 < score(base))));
    if (next && (!fits(base,camera,width,height,1.05) || basePitch < current*0.65)) { detail=next; since=now; }
  }
  return {base,detail,since};
}

// Mirrors cache_tile ordering in WGSL. Used only for diagnostic sampling.
export function tileIndex(x, y, image) {
  const gx=Math.ceil(image.texture.width/64), gy=Math.ceil(image.texture.height/64);
  const fx=Math.floor(image.geometry[2]/64), fy=Math.floor(image.geometry[3]/64);
  const ex=Math.min(gx,Math.ceil((image.texture.width-image.geometry[2])/64));
  const ey=Math.min(gy,Math.ceil((image.texture.height-image.geometry[3])/64));
  const iw=ex-fx, ih=ey-fy, visible=iw*ih, side=fx+gx-ex;
  if(x>=fx && x<ex && y>=fy && y<ey) return (y-fy)*iw+x-fx;
  if(y<fy) return visible+y*gx+x;
  if(y<ey) return visible+fy*gx+(y-fy)*side+(x<fx?x:fx+x-ex);
  return visible+fy*gx+ih*side+(y-ey)*gx+x;
}

export function coverage(layers,camera,width,height,now,fadeMs,since) {
  let covered=0,sharp=0; const magnifications=[];
  for(let y=0;y<5;y++) for(let x=0;x<9;x++) {
    let best=Infinity;
    for(let i=0;i<layers.length;i++) {
      const image=layers[i], ratio=camera[2]/image.camera[2];
      const u=((2*(x+0.5)/9-1)*width/height*ratio+(camera[0]-image.camera[0])/image.camera[2]);
      const v=((2*(y+0.5)/5-1)*ratio-(camera[1]-image.camera[1])/image.camera[2]);
      const px=(u*image.geometry[1]+image.texture.width)/2, py=(v*image.geometry[1]+image.texture.height)/2;
      if(px<0||py<0||px>=image.texture.width||py>=image.texture.height) continue;
      if(tileIndex(Math.floor(px/64),Math.floor(py/64),image)>=image.nextTile) continue;
      if(i>0 && now-Math.max(since,image.lastBatchAt??0)<fadeMs) continue;
      best=Math.min(best,height/(image.geometry[1]*ratio));
    }
    if(Number.isFinite(best)) { covered++;magnifications.push(best); if(best<=1.1) sharp++; }
  }
  return {coverage:covered/45,sharpCoverage:sharp/45,maxMagnification:Math.max(0,...magnifications)};
}
export function percentile(values,p) {
  if(!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.ceil((sorted.length-1)*p)];
}
export class Metrics {
  constructor(limit=12000) { this.limit=limit; this.reset(); }
  reset() { this.frames=[];this.events={};this.dropped=0;this.cursor=0;this.latest=undefined; }
  event(name,amount=1) { this.events[name]=(this.events[name]??0)+amount; }
  sample(frame) { this.latest=frame; if(this.frames.length<this.limit)this.frames.push(frame);else{this.frames[this.cursor]=frame;this.cursor=(this.cursor+1)%this.limit;this.dropped++;} }
  snapshot() { const f=[...this.frames].sort((a,b)=>a.time-b.time);return {schemaVersion:1,samples:f.length,dropped:this.dropped,events:{...this.events},summary:{
    queueMsP50:percentile(f.map(x=>x.queueMs),.5),queueMsP95:percentile(f.map(x=>x.queueMs),.95),
    jobLatencyMsP95:percentile(f.flatMap(x=>x.jobLatencyMs??[]),.95),
    tilesPerSecond:f.length>1?f.reduce((sum,x)=>sum+(x.tiles??0),0)/Math.max(.001,(f.at(-1).time-f[0].time)/1000):null,
    frameGapMsP95:percentile(f.map(x=>x.frameGapMs),.95),maxLayers:Math.max(0,...f.map(x=>x.layers)),
    peakTextureMiB:Math.max(0,...f.map(x=>x.textureBytes/1048576)),
    sharpFrameFraction:f.length?f.filter(x=>x.sharpCoverage===1).length/f.length:null,
    staleDetailFrames:f.filter(x=>x.staleDetail).length,
    completedCacheHitFraction:f.length?f.filter(x=>x.cacheHit).length/f.length:null,
  },frames:f}; }
}
