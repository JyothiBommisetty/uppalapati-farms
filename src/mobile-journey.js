/* Mobile Journey: Ultra-performance hardware-accelerated JPEG canvas animation with smooth motion blending */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
}

export function initMobileJourney() {
  const journeyStage = document.querySelector('[data-journey]');
  const canvas = document.querySelector('[data-process-canvas]');
  if (!journeyStage || !canvas) return;

  const ctx = canvas.getContext('2d', { alpha: false });
  const captions = [...document.querySelectorAll('[data-caption]')].map((el) => {
    const [from, to] = el.dataset.t.split(',').map(Number);
    return { el, from, to };
  });

  const urlParams = new URLSearchParams(window.location.search);
  const isDebug = urlParams.get('debug') === '1';
  const isNoJar = urlParams.get('nojar') === '1';
  const isNoFx = urlParams.get('nofx') === '1';
  const isNoPrefetch = urlParams.get('noprefetch') === '1';
  const isNoCanvasResize = urlParams.get('nocanvasresize') === '1';

  const TOTAL_FRAMES = 576;
  const VIDEO_DURATION = 48.0;
  const WINDOW_SIZE = 48;
  const FRAME_WIDTH = 720;
  const FRAME_HEIGHT = 1280;

  const blobs = new Array(TOTAL_FRAMES).fill(null);
  const bitmaps = new Array(TOTAL_FRAMES).fill(null);
  const fetchStatus = new Array(TOTAL_FRAMES).fill(0); // 0: un-fetched, 1: fetching, 2: fetched
  const decodeStatus = new Array(TOTAL_FRAMES).fill(0); // 0: un-decoded, 1: decoding, 2: ready

  let targetProgress = 0;
  let smoothedProgress = 0;
  let currentFrameIndex = -1;
  let scrollDirection = 1; // 1: forward, -1: backward
  let activeCaption = null;
  let isVisible = true;
  let animFrameId = 0;
  let isScrolling = false;
  let scrollStopTimer = null;

  /* ---------- Diagnostics State ---------- */
  let windowResizeCount = 0;
  let canvasResizeCount = 0;
  let lastViewportWidth = window.innerWidth;
  let lastOrientation = window.screen?.orientation?.type || window.orientation;

  let drawTimes = [];
  let drawWorst = 0;

  let decodeTimes = [];
  let decodeWorst = 0;

  const longTaskTimestamps = [];
  if ('PerformanceObserver' in window) {
    try {
      const observer = new window.PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i++) {
          longTaskTimestamps.push(performance.now());
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      /* longtask observer fallback */
    }
  }

  let scrollEventsThisSec = 0;
  let lastScrollEventsPerSec = 0;
  let lastDesktopLoopCount = window.__desktopLoopCount || 0;
  let desktopLoopsPerSec = 0;

  let lastDiagTime = performance.now();
  let fpsCount = 0;
  let currentFps = 0;
  let debugOverlay = null;

  if (isDebug) {
    debugOverlay = document.createElement('div');
    debugOverlay.style.cssText =
      'position:fixed;bottom:10px;left:10px;z-index:9999;background:rgba(0,0,0,0.88);color:#00ff66;font-family:monospace;font-size:11px;padding:8px 12px;border-radius:6px;pointer-events:none;line-height:1.45;box-shadow:0 4px 14px rgba(0,0,0,0.4);max-width:320px;';
    document.body.appendChild(debugOverlay);
  }

  function getLongTasks5s() {
    const now = performance.now();
    while (longTaskTimestamps.length > 0 && longTaskTimestamps[0] < now - 5000) {
      longTaskTimestamps.shift();
    }
    return longTaskTimestamps.length;
  }

  function updateDebugInfo(renderedIndex) {
    if (!debugOverlay) return;
    fpsCount++;
    const now = performance.now();
    if (now - lastDiagTime >= 1000) {
      currentFps = Math.round((fpsCount * 1000) / (now - lastDiagTime));
      fpsCount = 0;

      lastScrollEventsPerSec = scrollEventsThisSec;
      scrollEventsThisSec = 0;

      const currentDesktopLoops = window.__desktopLoopCount || 0;
      desktopLoopsPerSec = currentDesktopLoops - lastDesktopLoopCount;
      lastDesktopLoopCount = currentDesktopLoops;

      lastDiagTime = now;
    }

    const drawAvg = drawTimes.length > 0 ? (drawTimes.reduce((a, b) => a + b, 0) / drawTimes.length).toFixed(2) : '0.00';
    const decodeAvg = decodeTimes.length > 0 ? (decodeTimes.reduce((a, b) => a + b, 0) / decodeTimes.length).toFixed(2) : '0.00';
    const decodedCount = bitmaps.filter(Boolean).length;
    const fetchedCount = blobs.filter(Boolean).length;
    const longTasks = getLongTasks5s();
    const isP2Active = !isNoPrefetch && !isScrolling && fetchedCount < TOTAL_FRAMES;

    const switches = [
      isNoJar ? 'nojar' : null,
      isNoFx ? 'nofx' : null,
      isNoPrefetch ? 'noprefetch' : null,
      isNoCanvasResize ? 'nocanvasresize' : null,
    ].filter(Boolean).join(' ') || 'none';

    debugOverlay.innerHTML =
      `<b>FLUID MOTION JPEG CANVAS DIAGNOSTICS</b><br>` +
      `FPS: <b>${currentFps}</b> (target 55-60)<br>` +
      `Frame: ${renderedIndex + 1} / ${TOTAL_FRAMES}<br>` +
      `Draw Time: ${drawAvg}ms (worst: ${drawWorst.toFixed(2)}ms)<br>` +
      `Decode Time: ${decodeAvg}ms (worst: ${decodeWorst.toFixed(2)}ms)<br>` +
      `Long Tasks (5s): <b>${longTasks}</b><br>` +
      `Resizes (win/canvas): ${windowResizeCount} / ${canvasResizeCount}<br>` +
      `Scroll Events/sec: ${lastScrollEventsPerSec}<br>` +
      `Desktop rAF Loop/sec: <b>${desktopLoopsPerSec}</b><br>` +
      `RAM Decoded: ${decodedCount} frames (~${(decodedCount * 3.68).toFixed(1)}MB)<br>` +
      `Blobs Fetched: ${fetchedCount} / ${TOTAL_FRAMES}<br>` +
      `Phase2 Prefetch: <b>${isP2Active ? 'ACTIVE' : isScrolling ? 'PAUSED (scrolling)' : 'IDLE'}</b><br>` +
      `Active A/B: <span style="color:#ffcc00">${switches}</span>`;
  }

  /* ---------- Canvas Sizing ---------- */
  function applyCanvasSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const bw = Math.min(Math.round(rect.width * dpr), FRAME_WIDTH);
    const bh = Math.min(Math.round(rect.height * dpr), FRAME_HEIGHT);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      canvasResizeCount++;
    }
  }

  applyCanvasSize();

  let resizeDebounce = null;
  function handleResize() {
    windowResizeCount++;
    if (isNoCanvasResize) return;

    const currentWidth = window.innerWidth;
    const currentOrientation = window.screen?.orientation?.type || window.orientation;

    if (currentWidth === lastViewportWidth && currentOrientation === lastOrientation) {
      return;
    }

    lastViewportWidth = currentWidth;
    lastOrientation = currentOrientation;

    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(applyCanvasSize, 200);
  }
  window.addEventListener('resize', handleResize, { passive: true });

  /* ---------- Frame URL generator (.jpg hardware JPEG) ---------- */
  function getFrameUrl(index) {
    const num = String(index + 1).padStart(4, '0');
    return `/media/mobile/frame-${num}.jpg`;
  }

  /* ---------- Fetch & Decode Pipelines ---------- */
  async function fetchFrame(index) {
    if (index < 0 || index >= TOTAL_FRAMES || fetchStatus[index] !== 0) return;
    fetchStatus[index] = 1;
    try {
      const res = await fetch(getFrameUrl(index));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      blobs[index] = blob;
      fetchStatus[index] = 2;
    } catch {
      fetchStatus[index] = 0;
    }
  }

  async function decodeFrame(index) {
    if (index < 0 || index >= TOTAL_FRAMES) return;
    if (bitmaps[index] || decodeStatus[index] !== 0 || !blobs[index]) return;

    decodeStatus[index] = 1;
    const t0 = performance.now();
    try {
      if ('createImageBitmap' in window) {
        const bitmap = await window.createImageBitmap(blobs[index]);
        bitmaps[index] = bitmap;
      } else {
        const url = URL.createObjectURL(blobs[index]);
        const img = new Image();
        img.src = url;
        await img.decode();
        URL.revokeObjectURL(url);
        bitmaps[index] = img;
      }
      decodeStatus[index] = 2;
      const duration = performance.now() - t0;
      decodeTimes.push(duration);
      if (decodeTimes.length > 60) decodeTimes.shift();
      if (duration > decodeWorst) decodeWorst = duration;
    } catch {
      decodeStatus[index] = 0;
    }
  }

  function evictBitmapsOutsideWindow(targetIdx) {
    let winStart, winEnd;
    if (scrollDirection >= 0) {
      winStart = Math.max(0, targetIdx - 10);
      winEnd = Math.min(TOTAL_FRAMES - 1, targetIdx + (WINDOW_SIZE - 10));
    } else {
      winStart = Math.max(0, targetIdx - (WINDOW_SIZE - 10));
      winEnd = Math.min(TOTAL_FRAMES - 1, targetIdx + 10);
    }

    // Evict bitmaps outside sliding window
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      if ((i < winStart || i > winEnd) && bitmaps[i]) {
        if (typeof bitmaps[i].close === 'function') {
          bitmaps[i].close();
        }
        bitmaps[i] = null;
        decodeStatus[i] = 0;
      }
    }

    // Decode target frame and look-ahead priority frames in sliding window
    for (let i = winStart; i <= winEnd; i++) {
      if (blobs[i] && !bitmaps[i] && decodeStatus[i] === 0) {
        decodeFrame(i);
      }
    }
  }

  /* ---------- Rapid Sequential Preloader ---------- */
  async function startPreloader() {
    // Phase 0: Immediate frame 0 fetch & decode
    await fetchFrame(0);
    await decodeFrame(0);
    renderCanvas(0);

    // Phase 1: Fetch sequential frames in parallel chunks of 8
    const BATCH_SIZE = 8;
    for (let i = 0; i < TOTAL_FRAMES; i += BATCH_SIZE) {
      const chunk = [];
      for (let j = i; j < Math.min(i + BATCH_SIZE, TOTAL_FRAMES); j++) {
        chunk.push(j);
      }
      await Promise.all(chunk.map(fetchFrame));

      // Decode initial window frames ahead
      if (i < WINDOW_SIZE) {
        for (let j = i; j < Math.min(i + BATCH_SIZE, WINDOW_SIZE); j++) {
          decodeFrame(j);
        }
      }
    }
  }

  /* ---------- Section Progress & Captions ---------- */
  function getSectionProgress() {
    const rect = journeyStage.getBoundingClientRect();
    const travel = journeyStage.offsetHeight - window.innerHeight;
    if (travel <= 0) return 0;
    return clamp(-rect.top / travel, 0, 1);
  }

  function updateCaptions(time) {
    const allowed = journeyStage.classList.contains('intro-gone');
    const next = allowed && time !== null ? captions.find((c) => c.from <= time && time <= c.to) : null;
    if (next === activeCaption) return;
    if (activeCaption) activeCaption.el.classList.remove('is-visible');
    activeCaption = next;
    if (next) next.el.classList.add('is-visible');
  }

  function updateJourneyUI(progress) {
    const introFade = 1 - easeInOut(clamp(progress / 0.07, 0, 1));
    journeyStage.style.setProperty('--intro-opacity', introFade.toFixed(4));
    journeyStage.style.setProperty('--intro-lift', `${(-32 * easeInOut(clamp(progress / 0.07, 0, 1))).toFixed(1)}px`);
    journeyStage.classList.toggle('intro-gone', introFade < 0.02);

    const exitWash = easeInOut(clamp((progress - 0.93) / 0.07, 0, 1));
    journeyStage.style.setProperty('--process-exit', exitWash.toFixed(4));

    updateCaptions(progress * VIDEO_DURATION);
  }

  /* ---------- Canvas Drawing with Motion Crossfading ---------- */
  function findNearestBitmap(idx) {
    if (bitmaps[idx]) return idx;
    for (let offset = 1; offset < TOTAL_FRAMES; offset++) {
      if (idx - offset >= 0 && bitmaps[idx - offset]) return idx - offset;
      if (idx + offset < TOTAL_FRAMES && bitmaps[idx + offset]) return idx + offset;
    }
    return -1;
  }

  function renderCanvas(exactProgress) {
    const exactFrame = clamp(exactProgress * (TOTAL_FRAMES - 1), 0, TOTAL_FRAMES - 1);
    const baseIdx = Math.floor(exactFrame);
    const nextIdx = Math.min(baseIdx + 1, TOTAL_FRAMES - 1);
    const alpha = exactFrame - baseIdx;

    const drawIdx1 = findNearestBitmap(baseIdx);
    if (drawIdx1 < 0) return;

    const img1 = bitmaps[drawIdx1];
    const cw = canvas.width;
    const ch = canvas.height;
    const frameAspect = FRAME_WIDTH / FRAME_HEIGHT;
    const canvasAspect = cw / ch;

    let drawW, drawH, dx, dy;
    if (canvasAspect > frameAspect) {
      drawW = cw;
      drawH = cw / frameAspect;
      dx = 0;
      dy = (ch - drawH) / 2;
    } else {
      drawH = ch;
      drawW = ch * frameAspect;
      dx = (cw - drawW) / 2;
      dy = 0;
    }

    const t0 = performance.now();
    const rDx = Math.round(dx);
    const rDy = Math.round(dy);
    const rDw = Math.round(drawW);
    const rDh = Math.round(drawH);

    ctx.globalAlpha = 1.0;
    ctx.drawImage(img1, rDx, rDy, rDw, rDh);

    // Smooth sub-frame motion blend if adjacent frame is available
    if (nextIdx !== baseIdx && bitmaps[nextIdx] && alpha > 0.05) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(bitmaps[nextIdx], rDx, rDy, rDw, rDh);
      ctx.globalAlpha = 1.0;
    }

    const duration = performance.now() - t0;
    drawTimes.push(duration);
    if (drawTimes.length > 60) drawTimes.shift();
    if (duration > drawWorst) drawWorst = duration;

    updateDebugInfo(baseIdx);
  }

  /* ---------- Scroll & Animation Frame Loop ---------- */
  function onScroll() {
    scrollEventsThisSec++;
    isScrolling = true;
    clearTimeout(scrollStopTimer);
    scrollStopTimer = setTimeout(() => {
      isScrolling = false;
    }, 200);

    targetProgress = getSectionProgress();
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  function tick() {
    if (isVisible) {
      const prevProgress = smoothedProgress;
      // Silk-smooth momentum lerping matching desktop fluid velocity (0.08)
      smoothedProgress += (targetProgress - smoothedProgress) * 0.08;
      if (Math.abs(targetProgress - smoothedProgress) < 0.0001) {
        smoothedProgress = targetProgress;
      }

      const diff = smoothedProgress - prevProgress;
      if (Math.abs(diff) > 0.0001) {
        scrollDirection = diff >= 0 ? 1 : -1;
      }

      updateJourneyUI(smoothedProgress);

      const frameIdx = clamp(Math.round(smoothedProgress * (TOTAL_FRAMES - 1)), 0, TOTAL_FRAMES - 1);
      if (frameIdx !== currentFrameIndex) {
        currentFrameIndex = frameIdx;
        evictBitmapsOutsideWindow(frameIdx);
      }

      renderCanvas(smoothedProgress);
    }
    animFrameId = requestAnimationFrame(tick);
  }

  /* ---------- Intersection Observer (Off-screen pause) ---------- */
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          isVisible = entry.isIntersecting;
        });
      },
      { rootMargin: '200px 0px 200px 0px' }
    );
    observer.observe(journeyStage);
  }

  targetProgress = getSectionProgress();
  smoothedProgress = targetProgress;
  startPreloader();
  tick();

  return () => {
    cancelAnimationFrame(animFrameId);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', handleResize);
    clearTimeout(scrollStopTimer);
    clearTimeout(resizeDebounce);
    if (debugOverlay) debugOverlay.remove();
  };
}
