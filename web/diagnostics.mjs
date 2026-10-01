import { stressPath } from './stress-path.mjs';
export function mountDiagnostics({metrics,canvas,rust,interacting,syncSliders,controls,clearCache,metadata}) {
  const panel=document.createElement('details');panel.open=true;
  panel.style.cssText='position:fixed;top:10px;left:10px;z-index:20;background:#101826ed;color:#eee;padding:12px;border:1px solid #678;border-radius:8px;font:12px monospace;max-width:440px;max-height:60vh;overflow:auto';
  panel.innerHTML='<summary>Renderer diagnostics</summary><pre id="render-live"></pre><button id="run-benchmark">Run zoom benchmark</button> <button id="export-metrics">Export metrics JSON</button><p id="benchmark-status">No benchmark run</p><pre id="benchmark-report"></pre>';
  document.body.append(panel);
  const live=panel.querySelector('#render-live'), status=panel.querySelector('#benchmark-status'), output=panel.querySelector('#benchmark-report'), button=panel.querySelector('#run-benchmark');
  const stressRound=Number(new URLSearchParams(location.search).get('stress')??0);
  const continuous=new URLSearchParams(location.search).get('motion')==='1';
  const scenario=stressRound?`random-navigation-v1-round-${stressRound}${continuous?'-continuous':''}`:'zoom-regression-v1';
  let result, busy=false;
  const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  setInterval(()=>{ const f=metrics.latest;if(!f)return;
    live.textContent=`Zoom ${f.zoom.toFixed(0)}× | layers ${f.layers} | jobs ${f.jobs}\nQueue completion ${f.queueMs.toFixed(1)} ms (wall time)\nSharp coverage ${(100*f.sharpCoverage).toFixed(0)}% (45-point estimate)\nTextures ${(f.textureBytes/1048576).toFixed(0)} MiB | stale detail ${f.staleDetail}`;
  },500);
  function zoom(value) { rust.set_zoom_level(Math.log2(value));interacting();syncSliders(); }
  async function settle(name,target,timeout=8000) {
    const started=performance.now();let consecutive=0,lastSample=-Infinity;
    while(performance.now()-started<timeout) {
      await nextFrame(); if(document.hidden) throw new Error('Benchmark interrupted: tab hidden');
      const f=metrics.latest;
      if(f && f.time<=lastSample) continue;
      if(f) lastSample=f.time;
      if(f && f.time>=started && Math.abs(f.zoom/target-1)<0.001 && f.sharpCoverage===1 && !f.staleDetail) consecutive++;else consecutive=0;
      if(consecutive>=3)return {name,pass:true,settleMs:performance.now()-started,target};
    }
    return {name,pass:false,settleMs:timeout,target,reason:'View did not reach full estimated sharp coverage'};
  }
  button.onclick=async()=>{
    if(busy)return;busy=true;button.disabled=true;controls.disabled=true;output.textContent='';result=undefined;
    const runMetadata={...metadata(),iterations:384,fractal:'mandelbrot',palettePaused:true,stressRound,continuous,seed:20261001};const checks=[];
    try {
      metrics.reset();clearCache();
      document.querySelector('#fractal').value='0';controls.querySelector('legend').textContent='MANDELBROT';
      canvas.setAttribute('aria-label','Mandelbrot fractal rendered by a Rust-controlled WebGPU shader');
      rust.set_fractal(0);rust.reset_view();rust.explore_detail();rust.toggle_pause();
      const pause=controls.querySelector('[data-action="pause"]');pause.textContent='Resume colors';pause.setAttribute('aria-pressed','true');zoom(1);
      status.textContent='Warming up at 1×'; checks.push(await settle('cold start',1));
      if (stressRound) {
        const path=stressPath(stressRound); let previousZoom=400;
        rust.explore_detail();zoom(400);
        for(const [index,step] of path.entries()) {
          status.textContent=`Random stress ${stressRound}: ${index+1}/${path.length} (${Math.round(step.zoom)}×)`;
          // Revisit the detailed boundary each burst; random gestures then explore locally.
          if(index%4===0){rust.explore_detail();previousZoom=400;}
          if(continuous) {
            const started=performance.now(), from=previousZoom;let lastT=0,lastZoom=from;
            while(lastT<1) {
              const timestamp=await nextFrame();if(document.hidden)throw new Error('Benchmark interrupted: tab hidden');
              const t=Math.min(1,(timestamp-started)/320), nextZoom=from*(step.zoom/from)**t;
              rust.zoom_at(lastZoom/nextZoom,step.anchorX,step.anchorY);
              rust.drag(step.panX*(t-lastT),step.panY*(t-lastT));interacting();syncSliders();
              lastT=t;lastZoom=nextZoom;
            }
          } else {
            rust.zoom_at(previousZoom/step.zoom,step.anchorX,step.anchorY);
            rust.drag(step.panX,step.panY); interacting();syncSliders();
            const until=performance.now()+80;while(performance.now()<until)await nextFrame();
          }
          previousZoom=step.zoom;
          if(index%4===3) checks.push(await settle(`random checkpoint ${index+1}`,step.zoom,4000));
        }
        if(continuous){
          rust.explore_detail();const peak=Math.max(...path.map(step=>step.zoom));zoom(peak);
          checks.push(await settle('detail preset at maximum zoom',peak,4000));
        }
        zoom(1);checks.push(await settle('random zoom out recovers',1,4000));
      } else {
      status.textContent='Smooth zoom 1× → 5,000×';const start=performance.now();
      let t=0;while(t<1) { const now=await nextFrame();if(document.hidden)throw new Error('Benchmark interrupted: tab hidden');t=Math.min(1,(now-start)/10000);zoom(5000**t); }
      checks.push(await settle('smooth zoom settles',5000));
      status.textContent='Large jump to 14,900×';zoom(14900);checks.push(await settle('large zoom jump settles',14900));
      status.textContent='Rapid reversal and repeated jumps';
      for(const value of [1,5000,14900,32,14900]) { zoom(value);const until=performance.now()+120;while(performance.now()<until)await nextFrame(); }
      checks.push(await settle('burst zoom settles',14900));
      zoom(1);checks.push(await settle('zoom out recovers coverage',1));
      }
      const snap=metrics.snapshot();
      checks.push({name:'no orphaned detail selected',pass:snap.summary.staleDetailFrames===0});
      checks.push({name:'at most two display layers',pass:snap.summary.maxLayers<=2});
      checks.push({name:'texture budget respected',pass:snap.summary.peakTextureMiB<=runMetadata.textureBudgetBytes/1048576});
      result={...snap,metadata:runMetadata,scenario,checks,pass:checks.every(x=>x.pass)};
      status.textContent=result.pass?'Benchmark passed':'Benchmark failed';
    } catch(error) { result={...metrics.snapshot(),metadata:runMetadata,scenario,checks,pass:false,error:error.message};status.textContent=error.message; }
    finally { output.textContent=JSON.stringify({...result,frames:undefined},null,2);busy=false;button.disabled=false;controls.disabled=false;syncSliders(); }
  };
  panel.querySelector('#export-metrics').onclick=()=>{
    const report=result??{...metrics.snapshot(),metadata:metadata(),scenario:'manual'};
    const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='renderer-metrics.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  };
}
