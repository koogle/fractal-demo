// Browser resource handles stay in JS. Rust receives only numeric metadata and
// returns IDs, so policy never depends on WebGPU objects or the DOM.
export class RenderPlanner {
  constructor(rust) { this.rust=rust; this.capacity=rust.planner_capacity(); }
  read(pointer,length) { return new Float64Array(this.rust.memory.buffer,pointer,length).slice(); }
  load(images,jobs,camera=this.camera,width=this.width,height=this.height,now=this.now) {
    this.camera=camera;this.width=width;this.height=height;this.now=now;
    const resources=[...images,...jobs];
    if(resources.length>this.capacity)throw new Error('Render planner metadata capacity exceeded');
    const input=new Float64Array(this.rust.memory.buffer,this.rust.planner_input_ptr(),resources.length*16);
    for(const [index,image] of resources.entries())input.set([
      image.id,...image.camera,image.geometry[1],image.texture.width,image.texture.height,
      Number(image.complete),Number(index>=images.length),image.nextTile,image.totalTiles,
      image.bytes,image.used,image.completedAt??0,image.geometry[0],0,
    ],index*16);
    this.rust.planner_load(resources.length,...camera,width,height,now);
    return new Map(resources.map(image=>[image.id,image]));
  }
  reset() { this.rust.planner_reset(); }
  fits(image,camera,width,height,max=Infinity) {
    return Boolean(this.rust.planner_fits(...image.camera,image.geometry[1],image.texture.width,image.texture.height,...camera,width,height,max));
  }
  cached(images,camera,width,height,now) {
    const resources=this.load(images,[],camera,width,height,now);
    const [ready,displayed]=this.read(this.rust.planner_cached(),2);
    return {ready:resources.get(ready),displayed:resources.get(displayed)};
  }
  targets(camera,now,moving,anchor,direction,count) {
    const pointer=this.rust.planner_targets(...camera,now,Number(moving),...anchor,direction,count);
    const [length,nextDirection]=this.read(pointer,2), values=this.read(pointer+16,length*3);
    return {direction:nextDirection,targets:Array.from({length},(_,i)=>Array.from(values.slice(i*3,i*3+3)))};
  }
  schedule(images,jobs,maxJobs,extent) {
    const resources=this.load(images,jobs);
    const pointer=this.rust.planner_schedule(maxJobs,extent);
    const [retireCount,requestCount]=this.read(pointer,2);
    const retired=Array.from(this.read(pointer+16,retireCount),id=>resources.get(id));
    const requests=this.read(pointer+16+retireCount*8,requestCount*4);
    return {retired,requests:Array.from({length:requestCount},(_,i)=>({
      index:requests[i*4],camera:Array.from(requests.slice(i*4+1,i*4+4)),
    }))};
  }
  reprojection(image,layer,fadeMs) {
    const pointer=this.rust.planner_reprojection(image.id,layer,fadeMs);
    return new Float32Array(this.rust.memory.buffer,pointer,16).slice();
  }
  select(images,jobs,fadeMs) {
    const resources=this.load(images,jobs);
    const pointer=this.rust.planner_select(fadeMs);
    const [base,detail,since,count]=this.read(pointer,4);
    return {base:resources.get(base),detail:resources.get(detail),since,
      jobs:Array.from(this.read(pointer+32,count),id=>resources.get(id))};
  }
  evictions(images,reserved,budget,limit,protectedImage) {
    const resources=this.load(images,[]);
    const pointer=this.rust.planner_evict(reserved,budget,limit,protectedImage?.id??0);
    const [count]=this.read(pointer,1);
    return Array.from(this.read(pointer+8,count),id=>resources.get(id));
  }
}
