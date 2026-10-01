// WebGPU orchestration only: Rust owns the 3D camera, parameters, and WGSL.
const canvas=document.querySelector('#canvas'), controls=document.querySelector('#controls');
const status=document.querySelector('#render-status');
let stopped=false, timer, animation;
function fail(error){stopped=true;clearTimeout(timer);cancelAnimationFrame(animation);controls.disabled=true;const el=document.querySelector('#error');el.textContent=error.message??String(error);el.hidden=false;}
async function start(){
  if(!navigator.gpu)throw new Error('This demo needs WebGPU. Use a supported browser on localhost or HTTPS.');
  const response=await fetch('./fractal.wasm',{cache:'no-store'});
  if(!response.ok)throw new Error('Could not load fractal.wasm. Run make build.');
  const {instance}=await WebAssembly.instantiateStreaming(response,{}), rust=instance.exports;
  if(!rust.scene3d_frame)throw new Error('Rebuild the Rust library with make build to enable 3D.');
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)throw new Error('No WebGPU adapter is available.');
  const device=await adapter.requestDevice(), context=canvas.getContext('webgpu');
  if(!context)throw new Error('Could not create a WebGPU canvas.');
  device.lost.then(({message})=>fail(new Error(`GPU device lost. Refresh to restart. ${message}`)));
  device.addEventListener('uncapturederror',e=>fail(e.error));
  const format=navigator.gpu.getPreferredCanvasFormat();context.configure({device,format,alphaMode:'opaque'});
  const source=new TextDecoder().decode(new Uint8Array(rust.memory.buffer,rust.scene3d_shader_ptr(),rust.scene3d_shader_len()));
  const module=device.createShaderModule({code:source});
  const info=await module.getCompilationInfo(), errors=info.messages.filter(m=>m.type==='error');
  if(errors.length)throw new Error(errors.map(m=>`${m.lineNum}: ${m.message}`).join('\n'));
  const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vertex_main'},fragment:{module,entryPoint:'fragment_main',targets:[{format}]},primitive:{topology:'triangle-list'}});
  const uniforms=device.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniforms}}]});
  let revision=0, rendered=-1, busy=false, dragging, panMode=false, lastInput=-Infinity, full=false, motionResolution=720, lightMoving=true;
  function invalidate(){revision++;lastInput=performance.now();schedule();}
  function schedule(){if(!animation&&!busy&&!stopped&&!document.hidden)animation=requestAnimationFrame(render);}
  async function render(now){
    animation=undefined;if(stopped||document.hidden)return;
    const moving=!!dragging||now-lastInput<160;
    if(!lightMoving&&rendered===revision&&(full||moving))return;
    busy=true;const version=revision;
    try{
      // Fresh camera rays during motion; no stale flat image reprojection in 3D.
      const limit=moving?motionResolution:lightMoving?1000:1400;
      const scale=Math.min(devicePixelRatio,limit/Math.max(innerWidth,innerHeight));
      const width=Math.max(1,Math.round(innerWidth*scale)),height=Math.max(1,Math.round(innerHeight*scale));
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      device.queue.writeBuffer(uniforms,0,new Float32Array(rust.memory.buffer,rust.scene3d_frame(width,height,moving?1:0,now/1000),28));
      const encoder=device.createCommandEncoder();const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0.02,g:0.03,b:0.05,a:1}}]});
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
      const start=performance.now();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
      const elapsed=performance.now()-start;
      if(moving)motionResolution=Math.max(400,Math.min(960,motionResolution*Math.max(.8,Math.min(1.1,Math.sqrt(20/Math.max(1,elapsed))))));
      rendered=version;full=!moving;
      status.textContent=`${moving?'Navigating':lightMoving?'Moving light':'Refined'} · ${width} × ${height} · ${Math.round(elapsed)} ms GPU queue`;
    }catch(error){fail(error);}finally{busy=false;}
    if(stopped)return;
    if(revision!==rendered)schedule();
    else if(lightMoving){clearTimeout(timer);timer=setTimeout(schedule,16);}
    else if(!full){clearTimeout(timer);timer=setTimeout(schedule,180);}
  }
  for(const mode of ['orbit','pan'])document.querySelector(`#${mode}`).onclick=()=>{
    panMode=mode==='pan';document.querySelector('#pan').setAttribute('aria-pressed',String(panMode));document.querySelector('#orbit').setAttribute('aria-pressed',String(!panMode));
  };
  canvas.addEventListener('pointerdown',e=>{if(![0,1,2].includes(e.button)||dragging)return;canvas.setPointerCapture(e.pointerId);dragging={id:e.pointerId,x:e.clientX,y:e.clientY,pan:panMode||e.shiftKey||e.button!==0};canvas.classList.add('dragging');});
  canvas.addEventListener('pointermove',e=>{if(!dragging||e.pointerId!==dragging.id)return;const h=canvas.clientHeight,dx=(e.clientX-dragging.x)/h,dy=(e.clientY-dragging.y)/h;dragging.x=e.clientX;dragging.y=e.clientY;if(dragging.pan||e.shiftKey)rust.scene3d_pan(dx,dy);else rust.scene3d_orbit(dx,dy);invalidate();});
  function release(e){if(dragging?.id!==e.pointerId)return;dragging=undefined;canvas.classList.remove('dragging');invalidate();}
  canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);canvas.addEventListener('lostpointercapture',release);
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('wheel',e=>{e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?innerHeight:1;
    if(e.shiftKey&&!e.ctrlKey)rust.scene3d_pan((e.deltaX||e.deltaY)*unit/innerHeight,0);
    else rust.scene3d_zoom(Math.exp(Math.max(-.3,Math.min(.3,e.deltaY*unit*(e.ctrlKey ? .008 : .002)))));
    invalidate();},{passive:false});
  document.querySelector('#light').onclick=()=>{lightMoving=!lightMoving;rust.scene3d_light(lightMoving?1:0);const button=document.querySelector('#light');button.textContent=lightMoving?'Pause light':'Resume light';button.setAttribute('aria-pressed',String(lightMoving));invalidate();};
  document.querySelector('#closer').onclick=()=>{rust.scene3d_zoom(.8);invalidate();};
  document.querySelector('#farther').onclick=()=>{rust.scene3d_zoom(1.25);invalidate();};
  document.querySelector('#reset').onclick=()=>{rust.scene3d_reset();document.querySelector('#power').value=8;document.querySelector('#detail').value=12;parameters();};
  function parameters(){const power=Number(document.querySelector('#power').value),detail=Number(document.querySelector('#detail').value);rust.scene3d_parameters(power,detail);document.querySelector('#power-value').value=power;document.querySelector('#detail-value').value=detail;invalidate();}
  document.querySelector('#power').oninput=parameters;document.querySelector('#detail').oninput=parameters;
  addEventListener('resize',()=>{full=false;invalidate();});
  document.addEventListener('visibilitychange',()=>{rust.scene3d_light(lightMoving&&!document.hidden?1:0);if(!document.hidden){full=false;rendered=-1;schedule();}});
  addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);cancelAnimationFrame(animation);device.destroy();});
  // A back/forward-cache restore must recreate the GPU device destroyed above.
  addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
  controls.disabled=false;schedule();
}
start().catch(fail);
