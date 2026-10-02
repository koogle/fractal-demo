import { coverage, Metrics } from './render-health.mjs';
import { RenderPlanner } from './render-plan.mjs?v=rust-runtime-2';
const canvas = document.querySelector('#canvas');
const errorElement = document.querySelector('#error');
const controls = document.querySelector('#controls');
let animationId, workTimer;

function showError(message) {
  cancelAnimationFrame(animationId);
  clearTimeout(workTimer);
  errorElement.textContent = message;
  errorElement.hidden = false;
  controls.disabled = true;
}

async function start() {
  if (!navigator.gpu) throw new Error('This demo needs a browser with WebGPU enabled.');
  const response = await fetch('./fractal.wasm', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load the Rust library (${response.status}). Run make build.`);
  const { instance } = await WebAssembly.instantiateStreaming(response, {});
  const rust = instance.exports;
  const planner = new RenderPlanner(rust);
  const shader = new TextDecoder().decode(
    new Uint8Array(rust.memory.buffer, rust.shader_ptr(), rust.shader_len()),
  );

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  const device = await adapter.requestDevice();
  device.lost.then(({ message }) => showError(`GPU device lost. Refresh to restart. ${message}`));
  device.addEventListener('uncapturederror', (event) => showError(event.error.message));
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Could not create a WebGPU canvas.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const module = device.createShaderModule({ code: shader });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter((message) => message.type === 'error');
  if (errors.length) throw new Error(errors.map((error) => `${error.lineNum}: ${error.message}`).join('\n'));
  // Escape counts use 32-bit floats and are read without filtering.
  const displayLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 9, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
  ] });
  const pipeline = await device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [displayLayout] }),
    vertex: { module, entryPoint: 'vertex_main' },
    fragment: { module, entryPoint: 'fragment_main', targets: [{ format, blend: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } }] },
    primitive: { topology: 'triangle-list' },
  });
  const [computePipeline, preparePipeline, repairPipeline] = await Promise.all(
    ['compute_main', 'prepare_repairs', 'repair_main'].map((entryPoint) =>
      device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } })),
  );
  const uniformSize = rust.uniform_size();
  const uniforms = device.createBuffer({ size: uniformSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const repairCount = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const repairDispatch = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
  const prepareGroup = device.createBindGroup({
    layout: preparePipeline.getBindGroupLayout(0),
    entries: [{ binding: 6, resource: { buffer: repairCount } }, { binding: 7, resource: { buffer: repairDispatch } }],
  });
  // Completed images are reusable across palette changes and camera gestures.
  // The budget includes retained textures and all active render targets.
  const [memoryBudget,maxJobs,maxCachedImages,maxTileBatch,repairBytes,initialBatch,fadeMs] =
    new Float64Array(rust.memory.buffer,rust.render_config(device.limits.maxStorageBufferBindingSize,
      device.limits.maxBufferSize,device.limits.maxComputeWorkgroupsPerDimension),7).slice();
  const metricsEnabled = new URLSearchParams(location.search).has('metrics');
  const metrics = metricsEnabled ? new Metrics() : undefined;
  let lastFrameAt, lastInputAt;
  const images = [];
  const jobs = [];
  // Repair storage is reused by sequential repair passes, never by overlapping jobs.
  const repairPixels = device.createBuffer({ size: repairBytes, usage: GPUBufferUsage.STORAGE });
  let tileBatch = initialBatch;
  const fadeSeconds = fadeMs / 1000;
  let nextImageId = 1; // Zero is the Rust planner’s “no image” sentinel.
  let displayBase, displayDetail, detailSince = 0;
  let zoomDirection = 0.7, zoomAnchor = [0, 0];
  function interacting() { lastInputAt = performance.now(); }
  function releaseJobBuffers(job) {
    job.computeUniforms.destroy(); job.referenceBuffer.destroy();
  }
  function retireJob(job) {
    // Selected jobs must finish unless selection explicitly replaces them.
    const action=rust.planner_retirement(job.id);
    if (!action) return;
    metrics?.event('jobsRetired');
    metrics?.event('retiredTiles',job.nextTile);
    if (action===1) { disposeJob(job); return; }
    // Stop computing stale predictions, but retain pixels already on screen.
    // They remain fallback layers until sharper coverage makes them redundant.
    jobs.splice(jobs.indexOf(job), 1);
    releaseJobBuffers(job);
    job.complete = false;
    images.push(job);
  }
  function disposeJob(job) {
    jobs.splice(jobs.indexOf(job), 1);
    job.texture.destroy(); job.tileTimes.destroy(); job.reprojection.destroy(); releaseJobBuffers(job);
  }
  function evictImages(evicted) {
    for (const image of evicted) {
      images.splice(images.indexOf(image), 1);
      metrics?.event('evictions');
      image.texture.destroy(); image.tileTimes.destroy(); image.reprojection.destroy();
    }
  }
  function trimImages(reserved, protectedImage) {
    evictImages(planner.evictions(images, reserved, memoryBudget, maxCachedImages, protectedImage));
  }

  function createJob(camera, width, height, speculative, displayed, extent) {
    const visibleWidth = width, visibleHeight = height;
    const [textureWidth,textureHeight,padX,padY,bytes,totalTiles,tileBytes] =
      new Float64Array(rust.memory.buffer,rust.job_geometry(width,height,extent),7).slice();
    width=textureWidth; height=textureHeight;
    const allocation=planner.allocation(images,jobs,bytes,memoryBudget,maxCachedImages,displayed);
    evictImages(allocation.evicted);
    if (!allocation.allowed) return undefined;
    metrics?.event('jobsCreated');
    const pointer = rust.prepare_view(...camera, visibleWidth, visibleHeight, width / height, height / visibleHeight);
    if (!pointer) throw new Error('Invalid render camera');
    const frame = new Uint8Array(rust.memory.buffer, pointer, uniformSize).slice();
    const referenceLength = rust.reference_len();
    const texture = device.createTexture({ size: [width, height], format: 'rg32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const computeUniforms = device.createBuffer({ size: uniformSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const referenceBuffer = device.createBuffer({ size: 1026 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(referenceBuffer, 0,
      new Uint8Array(rust.memory.buffer, rust.reference_data_ptr(), (referenceLength + 1) * 16));
    const reprojection = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const tileTimes = device.createBuffer({ size: tileBytes,
      usage: GPUBufferUsage.STORAGE });
    const view = texture.createView();
    const displayGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 2, resource: view }, { binding: 3, resource: view },
      { binding: 8, resource: { buffer: reprojection } },
      { binding: 9, resource: { buffer: tileTimes } },
    ] });
    const computeGroup = device.createBindGroup({ layout: computePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: computeUniforms } }, { binding: 1, resource: view },
      { binding: 4, resource: { buffer: referenceBuffer } },
      { binding: 10, resource: { buffer: tileTimes } },
      { binding: 5, resource: { buffer: repairPixels } }, { binding: 6, resource: { buffer: repairCount } },
    ] });
    const repairGroup = device.createBindGroup({ layout: repairPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: computeUniforms } }, { binding: 1, resource: view },
      { binding: 5, resource: { buffer: repairPixels } }, { binding: 6, resource: { buffer: repairCount } },
    ] });
    return { id: nextImageId++, complete: false, texture, tileTimes, reprojection, displayGroup, bytes, camera, geometry: [visibleWidth, visibleHeight, padX, padY],
      frame, referenceLength, computeUniforms, referenceBuffer, computeGroup, repairGroup, speculative,
      nextTile: 0, totalTiles, used: performance.now(), createdAt: performance.now() };
  }
  const sliders = [
    ['zoom-level', 'zoom-value', rust.set_zoom_level, (value) => `${(2 ** value).toLocaleString(undefined, { maximumSignificantDigits: 3, notation: Math.abs(value) > 16 ? 'scientific' : 'standard' })}×`],
    ['iterations', 'iterations-value', rust.set_iterations, (value) => Math.round(value)],
    ['color-density', 'density-value', rust.set_color_density, (value) => value.toFixed(3)],
    ['color-speed', 'speed-value', rust.set_color_speed, (value) => `${value.toFixed(3)}/s`],
  ].map(([inputId, outputId, set, format]) => ({
    input: document.getElementById(inputId), output: document.getElementById(outputId), set, format,
  }));
  function syncSliders() {
    const values = new Float32Array(rust.memory.buffer, rust.read_settings(), sliders.length);
    sliders.forEach(({ input, output, format }, index) => {
      // Extend the slider window near either end instead of capping the view.
      if (index === 0) {
        if (values[index] < Number(input.min) + 1) input.min = Math.floor(values[index] - 8);
        if (values[index] > Number(input.max) - 1) input.max = Math.ceil(values[index] + 8);
      }
      input.value = values[index];
      output.value = format(values[index]);
    });
  }
  sliders.forEach(({ input, set }, index) => input.addEventListener('input', () => {
    if (index <= 1) interacting();
    set(Number(input.value));
    syncSliders();
  }));
  syncSliders();
  const fractalSelect = document.querySelector('#fractal');
  fractalSelect.addEventListener('change', () => {
    rust.set_fractal(Number(fractalSelect.value));
    const name = fractalSelect.selectedOptions[0].textContent;
    controls.querySelector('legend').textContent = name;
    canvas.setAttribute('aria-label', `${name} fractal rendered by a Rust-controlled WebGPU shader`);
    syncSliders();
  });
  let sliderSyncPending = false;
  function scheduleSliderSync() {
    if (sliderSyncPending) return;
    sliderSyncPending = true;
    requestAnimationFrame(() => { sliderSyncPending = false; syncSliders(); });
  }
  const pauseButton = controls.querySelector('[data-action="pause"]');
  function updatePauseButton(paused) {
    pauseButton.textContent = paused ? 'Resume colors' : 'Pause colors';
    pauseButton.setAttribute('aria-pressed', String(Boolean(paused)));
  }
  controls.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    if (action !== 'pause') interacting();
    switch (action) {
      case 'left': rust.pan(-1, 0); break;
      case 'right': rust.pan(1, 0); break;
      case 'up': rust.pan(0, 1); break;
      case 'down': rust.pan(0, -1); break;
      case 'in': zoomDirection = 0.7; zoomAnchor = [0, 0]; rust.zoom(0.7); break;
      case 'out': zoomDirection = 1 / 0.7; zoomAnchor = [0, 0]; rust.zoom(1 / 0.7); break;
      case 'detail': rust.explore_detail(); break;
      case 'pause': updatePauseButton(rust.toggle_pause()); break;
      case 'reset': rust.reset_view(); updatePauseButton(false); break;
    }
    syncSliders();
  });
  controls.disabled = false;
  let drag;
  function endDrag() {
    const pointerId = drag?.pointerId;
    drag = undefined;
    canvas.classList.remove('dragging');
    if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (controls.disabled || event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (event) => {
    if (controls.disabled || event.pointerId !== drag?.pointerId) return;
    const { height } = canvas.getBoundingClientRect();
    if (!height) return;
    // Move the image with the pointer, converting CSS pixels to shader space.
    interacting();
    rust.navigation_drag(event.clientX-drag.x,event.clientY-drag.y,height);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(name, (event) => {
      if (event.pointerId === drag?.pointerId) endDrag();
    });
  }
  window.addEventListener('blur', endDrag);
  canvas.addEventListener('wheel', (event) => {
    if (controls.disabled) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    if (!rect.height) return;
    interacting();
    const [direction,ax,ay]=new Float64Array(rust.memory.buffer,
      rust.navigation_wheel(event.deltaY,event.deltaMode,Number(event.ctrlKey),
        event.clientX-rect.left,event.clientY-rect.top,rect.width,rect.height),3);
    zoomDirection=direction;zoomAnchor=[ax,ay];
    scheduleSliderSync();
  }, { passive: false });
  if (metrics) {
    const {mountDiagnostics} = await import('./diagnostics.mjs');
    mountDiagnostics({metrics,canvas,rust,interacting,syncSliders,controls,
      clearCache:()=>rust.render_invalidate(),
      metadata:()=>({width:canvas.width,height:canvas.height,dpr:devicePixelRatio,
        userAgent:navigator.userAgent,iterations:new Float32Array(rust.memory.buffer,rust.read_settings(),4)[1],
        textureBudgetBytes:memoryBudget,maxJobs,maxTileBatch,fadeMs:fadeSeconds*1000}),
    });
  }
  const startTime = performance.now();

  async function render(now) {
    try {
      const encodingStarted=performance.now();
      const [width,height]=new Float64Array(rust.memory.buffer,
        rust.render_size(innerWidth,innerHeight,devicePixelRatio,device.limits.maxTextureDimension2D),2);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const texture = context.getCurrentTexture();
      const pointer = rust.update_frame(width, height, (now - startTime) / 1000);
      const frame = new Uint8Array(rust.memory.buffer, pointer, uniformSize).slice();
      device.queue.writeBuffer(uniforms, 0, frame);
      const moving = Boolean(rust.render_moving(now,lastInputAt??-Infinity,Number(Boolean(drag))));
      const exactCamera = Array.from(new Float64Array(rust.memory.buffer, rust.camera_ptr(), 3));
      const extent = rust.cache_extent();
      if (rust.render_settings_changed(width,height)) {
        [...jobs].forEach(disposeJob);
        images.splice(0).forEach(image => { image.texture.destroy(); image.tileTimes.destroy(); image.reprojection.destroy(); });
        planner.reset();
        displayBase = displayDetail = undefined;
      }
      const {ready, displayed} = planner.cached(images, exactCamera, width, height, now);
      if (displayed) displayed.used = now;
      const prediction = planner.targets(exactCamera, now, moving, zoomAnchor, zoomDirection, maxJobs);
      zoomDirection = prediction.direction;
      const schedule = planner.schedule(images, jobs, maxJobs, extent);
      for (const job of schedule.retired) retireJob(job);
      for (const {index, camera} of schedule.requests) {
        const job = createJob(camera, width, height, index !== 0, displayed, extent);
        if (job) jobs.push(job);
      }
      const selection = planner.select(images, jobs, fadeSeconds * 1000);
      displayBase = selection.base; displayDetail = selection.detail; detailSince = selection.since;
      jobs.splice(0, jobs.length, ...selection.jobs);
      const layers = (displayDetail ? [displayBase, displayDetail] : [displayBase]).filter(Boolean);
      for (const [index, image] of layers.entries()) {
        image.used = now;
        device.queue.writeBuffer(image.reprojection, 0,
          planner.reprojection(image, index, fadeSeconds * 1000));
      }
      const encoder = device.createCommandEncoder();
      const batches = [];
      // Bound sudden cost changes after a jump; cheap cached views must not
      // grow the next expensive submission into a long input stall.
      let remainingTiles = rust.planner_batch_limit(tileBatch, Number(moving));
      for (const [index, job] of jobs.entries()) {
        if (!remainingTiles) break;
        new Uint8Array(rust.memory.buffer,rust.compute_input_ptr(),uniformSize).set(job.frame);
        const computePointer=rust.compute_frame(job.texture.width,job.texture.height,job.nextTile,
          job.referenceLength,...job.geometry.slice(2),...job.geometry.slice(0,2),now/1000);
        const computeFrame=new Uint8Array(rust.memory.buffer,computePointer,uniformSize);
        const computeFloats=new Float32Array(rust.memory.buffer,computePointer,uniformSize/4);
        device.queue.writeBuffer(job.computeUniforms, 0, computeFrame);
        const share = rust.planner_batch_share(remainingTiles, index, jobs.length, Number(Boolean(ready)));
        const batch = rust.planner_batch_size(share,job.nextTile,job.totalTiles);
        remainingTiles -= batch;
        batches.push({ job, batch });
        encoder.clearBuffer(repairCount);
        const compute = encoder.beginComputePass();
        compute.setPipeline(computePipeline);
        compute.setBindGroup(0, job.computeGroup);
        compute.dispatchWorkgroups(8, 8, batch);
        compute.end();
        if (computeFloats[11] > 0.5) {
          const prepare = encoder.beginComputePass();
          prepare.setPipeline(preparePipeline);
          prepare.setBindGroup(0, prepareGroup);
          prepare.dispatchWorkgroups(1);
          prepare.end();
          const repair = encoder.beginComputePass();
          repair.setPipeline(repairPipeline);
          repair.setBindGroup(0, job.repairGroup);
          repair.dispatchWorkgroupsIndirect(repairDispatch, 0);
          repair.end();
        }
        job.nextTile += batch;
        job.lastBatchAt = performance.now();
      }
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(pipeline);
      for (const image of layers) {
        pass.setBindGroup(0, image.displayGroup);
        pass.draw(3);
      }
      pass.end();
      const submitted = performance.now();
      device.queue.submit([encoder.finish()]);
      // Keep only one submission in flight, so gestures never sit behind a
      // growing GPU queue. Tune tile batches against completion time, not FPS.
      await device.queue.onSubmittedWorkDone();
      if (batches.length) {
        const elapsed = performance.now() - submitted;
        const submittedTiles = batches.reduce((sum, item) => sum + item.batch, 0);
        tileBatch = rust.planner_tune_batch(submittedTiles, elapsed, Number(moving), maxJobs, maxTileBatch);
        planner.load(images,jobs);
        for (const job of planner.completed()) {
          jobs.splice(jobs.indexOf(job), 1);
          releaseJobBuffers(job);
          metrics?.event('jobsCompleted');
          job.complete = true;
          job.completedAt = performance.now();
          images.push(job);
        }
        planner.load(images,jobs);
        trimImages(rust.planner_bytes(1), displayed ?? images.at(-1));
      }
      if (metrics) {
        const finished=performance.now();
        metrics.sample({time:now, zoom:1.2/exactCamera[2], queueMs:finished-submitted,
          encodeWallMs:submitted-encodingStarted, frameGapMs:lastFrameAt===undefined?0:now-lastFrameAt,
          inputAgeMs:lastInputAt===undefined?null:finished-lastInputAt,
          layers:layers.length,jobs:jobs.length,images:images.length,
          jobLatencyMs:batches.filter(item=>item.job.complete).map(item=>item.job.completedAt-item.job.createdAt),
          textureBytes:planner.bytes(images,jobs),
          repairBytes:repairPixels.size, tiles:batches.reduce((sum,item)=>sum+item.batch,0),
          cacheHit:Boolean(ready),staleDetail:Boolean(displayDetail&&!displayDetail.complete&&!jobs.includes(displayDetail)),
          ...coverage(layers,exactCamera,width,height,finished,fadeSeconds*1000,detailSince),
        });
        lastFrameAt=now;
      }
      // Do not leave the GPU idle until the next display refresh while work
      // remains. Yield to input, then submit the next bounded batch immediately.
      if (rust.render_continue(jobs.length,Number(document.hidden))) {
        workTimer = setTimeout(() => render(performance.now()), 0);
      } else {
        animationId = requestAnimationFrame(render);
      }
    } catch (error) {
      showError(error.message);
    }
  }
  animationId = requestAnimationFrame(render);
}

start().catch((error) => showError(error.message));
