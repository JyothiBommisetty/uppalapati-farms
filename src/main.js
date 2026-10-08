/* Aliased because this module already has locals named cartCount and cartTotal
   for the badge and total elements; those shadow the imported helpers. */
import {
  products,
  currency,
  cartStorageKey,
  readCart,
  cartCount as countCartItems,
  cartTotal as totalCartValue,
  productImage,
} from './catalogue.js';
import { createJar3d } from './jar3d.js';

const journeyStage = document.querySelector('[data-journey]');
const processVideo = document.querySelector('[data-process-video]');
const captions = [...document.querySelectorAll('[data-caption]')].map((el) => {
  const [from, to] = el.dataset.t.split(',').map(Number);
  return { el, from, to };
});
const productStage = document.querySelector('[data-product-stage]');
const jarCanvas = document.querySelector('[data-jar-3d]');
const jarFallback = document.querySelector('[data-jar-fallback]');
const revealLabel = document.querySelector('[data-reveal-label]');
const revealLabelEnd = document.querySelector('[data-reveal-label-end]');
const cartTrigger = document.querySelector('[data-cart-trigger]');
const cartCount = document.querySelector('[data-cart-count]');
const cartDialog = document.querySelector('[data-cart-dialog]');
const cartItems = document.querySelector('[data-cart-items]');
const cartEmpty = document.querySelector('[data-cart-empty]');
const cartTotal = document.querySelector('[data-cart-total]');
const closeCartButton = document.querySelector('[data-close-cart]');
const checkoutButton = document.querySelector('[data-checkout]');
const addProductButtons = [...document.querySelectorAll('[data-add-product]')];
const loadingScreen = document.querySelector('[data-loading-screen]');
const loadingBar = document.querySelector('[data-loading-bar]');
const loadingProgress = document.querySelector('[data-loading-progress]');
const loadingPercent = document.querySelector('[data-loading-percent]');

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
// Two encodes of the same 48s film, both CRF 26 so each stays visually
// transparent - VMAF 97.3 (1080p) and 96.0 (720p) against the 4K master.
// The previous CRF 31 encode scored 89.2, which is where artifacting becomes
// visible. Ordered lightest to heaviest so a decode failure can step down.
//
// There is deliberately no 1440p tier. Cloudflare Pages rejects files over
// 25 MiB, and no 1440p encode that fits scores well: CRF 30 measured 90.4
// and a bitrate-capped CRF 26 measured 89.5. Upscaling this 1080p file to a
// 2560 screen scored 93.2, so the upscale is the better trade until the
// hosting cap moves. At 21.1 MiB the 1080p tier sits at 84.4% of that cap.
const filmSources = [
  { src: '/media/film-720.mp4', width: 1280 },
  { src: '/media/film-1080.mp4', width: 1920 },
];
// Phones stay on the light encode regardless of pixel density - a 720p file
// in a ~390px-wide slot is already oversampled.
const PHONE_WIDTH = 768;
const isMobilePortrait = window.matchMedia('(max-width: 768px) and (orientation: portrait)').matches;
const urlParams = new URLSearchParams(window.location.search);
const isNoJar = urlParams.get('nojar') === '1';
const isNoFx = urlParams.get('nofx') === '1';
const isUseCanvas = urlParams.get('canvas') === '1';

if (isNoFx) {
  document.body.classList.add('no-fx');
}

window.__desktopLoopCount = 0;

if (isMobilePortrait && isUseCanvas) {
  document.body.classList.add('use-canvas');
  processVideo?.removeAttribute('src');
  processVideo?.removeAttribute('preload');
  import('./mobile-journey.js').then((m) => m.initMobileJourney());
}
// Direct seek mode - no thresholding used

let scrollFrame = 0;
let resizeTimer = 0;
let videoDuration = 0;
let videoReady = false;
let activeVideoSource = '';
let activeCaption = null;
let seekTarget = -1;
let lastSeekTime = -1;
let jarTurnFraction = null;
let lastLabelFacingFront = null;
let isReducedMotion = motionQuery.matches;
let assetsDone = false;
let loadDone = false;
let cart = readCart();

// Failsafe: never let a boot error trap the visitor behind the loading screen.
window.setTimeout(() => {
  document.body.classList.add('is-ready');
  document.body.classList.remove('is-loading');
}, 6000);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
}

function getSectionProgress(section) {
  const rect = section.getBoundingClientRect();
  const travel = section.offsetHeight - window.innerHeight;
  if (travel <= 0) return 0;
  return clamp(-rect.top / travel, 0, 1);
}

/* ---------- Loading ---------- */

function renderLoadingProgress(value) {
  const percent = Math.round(clamp(value, 0, 1) * 100);
  if (loadingBar) loadingBar.style.transform = `scaleX(${(percent / 100).toFixed(4)})`;
  if (loadingProgress) loadingProgress.setAttribute('aria-valuenow', String(percent));
  if (loadingPercent) loadingPercent.textContent = `${percent}%`;
}

function revealSite() {
  document.body.classList.remove('is-loading');
  document.body.classList.add('is-ready');
  if (loadingScreen) loadingScreen.setAttribute('aria-hidden', 'true');
  renderLoadingProgress(1);
  syncScroll();
}

function finishLoading() {
  if (loadDone) return;
  loadDone = true;
  renderLoadingProgress(1);
  window.setTimeout(revealSite, 420);
}

function startLoadingScreen() {
  if (!loadingScreen) {
    finishLoading();
    return;
  }
  const startedAt = performance.now();
  let simulated = 0;
  const tick = () => {
    if (loadDone) return;
    const eased = 1 - Math.exp(-(performance.now() - startedAt) / 1600);
    simulated = Math.max(simulated, eased * 0.86);
    const shown = assetsDone ? Math.max(simulated, 0.92) : simulated;
    renderLoadingProgress(shown);
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
  window.setTimeout(finishLoading, 9000);
}

function preloadAssets() {
  // Both ghee jars are real <img> elements in the markup now and load lazily;
  // the film poster is not in the markup at all, so it is fetched here. The
  // half-litre photo is warmed only because it is the first card a visitor is
  // likely to scroll to.
  const images = ['/media/film-poster.jpg', '/media/ghee-half-litre.jpg'];
  let pending = images.length + 1;

  const settle = () => {
    pending -= 1;
    if (pending <= 0 && document.readyState !== 'loading') assetsDone = true;
  };

  images.forEach((src) => {
    const image = new Image();
    image.onload = settle;
    image.onerror = settle;
    image.src = src;
  });

  const settleVideo = () => {
    if (processVideo.readyState >= 2) settle();
  };
  if (!isMobilePortrait) {
    processVideo.addEventListener('loadeddata', settleVideo, { once: true });
    processVideo.addEventListener('error', settle, { once: true });
  } else {
    settle();
  }
  window.setTimeout(settle, 7000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (pending <= 0) assetsDone = true;
    });
  } else if (pending <= 0) {
    assetsDone = true;
  }
  window.setTimeout(() => {
    assetsDone = true;
  }, 8000);
}

/* ---------- Journey: intro overlay + scrubbed film ---------- */

function updateJourney() {
  if (isMobilePortrait && isUseCanvas) return;
  const rect = journeyStage.getBoundingClientRect();
  const isNearViewport = rect.bottom > 0 && rect.top < window.innerHeight;
  if (!isNearViewport || isReducedMotion) {
    return;
  }
  const progress = getSectionProgress(journeyStage);
  const introFade = 1 - easeInOut(clamp(progress / 0.07, 0, 1));
  journeyStage.style.setProperty('--intro-opacity', introFade.toFixed(4));
  journeyStage.style.setProperty('--intro-lift', `${(-32 * easeInOut(clamp(progress / 0.07, 0, 1))).toFixed(1)}px`);
  journeyStage.classList.toggle('intro-gone', introFade < 0.02);
  const exitWash = easeInOut(clamp((progress - 0.93) / 0.07, 0, 1));
  journeyStage.style.setProperty('--process-exit', exitWash.toFixed(4));
  requestVideoSeek(progress);
}

function updateCaptions(time) {
  // The intro carries the only H1 and the two CTAs, so a line shown underneath
  // it would stack two blocks of text on one frame. Wait for the intro to be
  // gone. The windows do not overlap, so the first match is the right one.
  const allowed = journeyStage.classList.contains('intro-gone');
  const next = allowed && time !== null ? captions.find((c) => time >= c.from && time <= c.to) : null;
  if (next === activeCaption) return;
  if (activeCaption) activeCaption.el.classList.remove('is-visible');
  activeCaption = next;
  if (next) next.el.classList.add('is-visible');
}

function requestVideoSeek(progress) {
  if (!videoReady || isReducedMotion || videoDuration <= 0) {
    updateCaptions(null);
    return;
  }
  seekTarget = clamp(progress, 0, 0.999) * videoDuration;
  // Drive captions off the target time rather than video.currentTime: the
  // target is what the frame is being seeked to, so the line cannot drift a
  // frame behind the picture while a seek is still decoding.
  updateCaptions(seekTarget);
}

/* ---------- Rotating jar (live 3D) ---------- */

const jar3d = jarCanvas
  ? createJar3d({
      canvas: jarCanvas,
      // The still stays hidden until the canvas has proved it can draw. It is
      // the only thing on the page if three.js, WebGL or the GLB is refused, so
      // it is shown on every failure path rather than left to an empty frame.
      onReady: () => {
        if (jarFallback) jarFallback.hidden = true;
      },
      onFail: () => {
        if (jarFallback) jarFallback.hidden = false;
      },
      onFraction: (fraction) => {
        jarTurnFraction = fraction;
      },
    })
  : null;

/* Kick the jar's download off as soon as the browser goes idle after first
   paint, rather than when the stage scrolls into view. It used to wait for
   exactly that, so anyone who scrolled to the stage spent their first seconds
   there looking at a still frame while a 15.6 MiB model fetched behind them,
   and the swap landed once the section had already been framed.

   Rendering is still gated on visibility (see updateProductStage), so this buys
   a head start on the download without costing a frame while the stage is off
   screen. jar3d.start() is itself idempotent, so nothing else has to guard it.

   The timeout is the half that matters: requestIdleCallback alone waits as long
   as the main thread stays busy, and decoding the opening of the film keeps it
   busy for the first few seconds. The cap makes the start predictable without
   putting 16 MiB in front of the first paint. */
if (jar3d) {
  const beginJar3dLoad = () => {
    if (isNoJar) return;
    jar3d.start();
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(beginJar3dLoad, { timeout: 2000 });
  } else {
    window.setTimeout(beginJar3dLoad, 1);
  }
}

function updateProductStage() {
  const progress = getSectionProgress(productStage);
  const revealProgress = easeInOut(clamp((progress - 0.1) / 0.5, 0, 1));
  const optionsProgress = easeInOut(clamp((progress - 0.32) / 0.3, 0, 1));
  productStage.style.setProperty('--reveal-y', `${(-26 * revealProgress).toFixed(2)}vh`);
  productStage.style.setProperty('--reveal-scale', (1 - revealProgress * 0.3).toFixed(4));
  productStage.style.setProperty('--halo-opacity', (0.72 - revealProgress * 0.5).toFixed(4));
  productStage.style.setProperty('--options-y', `${((1 - optionsProgress) * 42).toFixed(2)}px`);
  productStage.style.setProperty('--options-opacity', optionsProgress.toFixed(4));
  productStage.classList.toggle('options-visible', optionsProgress > 0.001);
  // The flanking copy arrives once the jar has settled and is gone again before
  // the cards are more than a hint visible, so the stage always has exactly one
  // thing to say. Four windows rather than one opacity, because a single value
  // can only fade both columns together - staggered, they read as two thoughts
  // arriving and leaving. The windows are wide on purpose: this section scrolls
  // 200svh, so a tenth of its progress is only ~180px of scroll, which is the
  // difference between a glance and something you can actually read.
  const factsIn = easeInOut(clamp((progress - 0.13) / 0.06, 0, 1));
  const factsInLag = easeInOut(clamp((progress - 0.16) / 0.06, 0, 1));
  const factsOut = easeInOut(clamp((0.38 - progress) / 0.08, 0, 1));
  const factsOutLag = easeInOut(clamp((0.41 - progress) / 0.08, 0, 1));
  const factsA = factsIn * factsOut;
  const factsB = factsInLag * factsOutLag;
  productStage.style.setProperty('--facts-opacity', factsA.toFixed(4));
  productStage.style.setProperty('--facts-opacity-lag', factsB.toFixed(4));
  productStage.style.setProperty('--facts-y', `${((factsA - 1) * 16).toFixed(2)}px`);
  const rect = productStage.getBoundingClientRect();
  const stageNear = rect.bottom > -window.innerHeight * 0.5 && rect.top < window.innerHeight * 1.5;
  // Rendering only. The load is no longer gated here: it starts once at
  // startup, so a jar that has been fetched while the stage was still below the
  // fold costs nothing per frame here and is simply waiting when it arrives.
  // Deliberately still not gated on revealProgress: that is the fly-in
  // animation, and it is 0 where the jar is first framed, which would freeze
  // the turntable on frame 0.
  jar3d?.setActive(stageNear);
}

/* ---------- Jar label swap ---------- */

function updateRevealLabels() {
  if (!revealLabel || !revealLabelEnd || jarTurnFraction === null) return;
  // Front-facing is the middle 44% of the turn, either side of the authored
  // front of the model. Unchanged from the 360 video, which was shot the same
  // way round.
  const facingFront = jarTurnFraction < 0.22 || jarTurnFraction > 0.78;
  if (facingFront === lastLabelFacingFront) return;
  lastLabelFacingFront = facingFront;
  revealLabel.style.opacity = facingFront ? '0.85' : '0';
  revealLabelEnd.style.opacity = facingFront ? '0' : '0.85';
}

/* ---------- Frame loop: 1:1 scroll-locked video seeking ---------- */

function syncScroll() {
  if (!isMobilePortrait) {
    updateJourney();
  }
  const rect = productStage.getBoundingClientRect();
  const stageNear = rect.bottom > -window.innerHeight * 0.5 && rect.top < window.innerHeight * 1.5;
  if (!isMobilePortrait || stageNear) {
    updateProductStage();
  }
}

function frame(now) {
  if (seekTarget >= 0 && videoDuration > 0) {
    const target = clamp(seekTarget, 0, videoDuration - 0.001);
    seekTarget = -1;
    // Slight lerp to avoid micro-stutters when scroll stops abruptly while
    // seeking keyframes. Keeps it responsive on fast scrolls.
    const current = lastSeekTime < 0 ? target : lastSeekTime;
    const isMobile = window.innerWidth <= PHONE_WIDTH;
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;
    const lowPower = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || 
                     ('deviceMemory' in navigator && navigator.deviceMemory <= 2);
    const deviceConstrained = isMobile || isCoarse || lowPower;
    const lerpFactor = deviceConstrained ? 0.15 : 0.08;
    let smoothed = current + (target - current) * lerpFactor;
    if (Math.abs(smoothed - target) < 0.0005) smoothed = target;
    try {
      processVideo.currentTime = target;
      lastSeekTime = target;
    } catch {
      /* seeking before metadata is ready */
    }
  }
  // The jar renders from the page's existing animation frame rather than a
  // loop of its own, so a turning jar does not double the per-frame cost.
  const journeyRect = journeyStage?.getBoundingClientRect();
  const journeyOnScreen = journeyRect && journeyRect.bottom > 0 && journeyRect.top < window.innerHeight;
  if (!isMobilePortrait || !journeyOnScreen) {
    window.__desktopLoopCount++;
    if (!isNoJar) {
      jar3d?.tick(now);
    }
    updateRevealLabels();
  }
  window.requestAnimationFrame(frame);
}

function scheduleScrollSync() {
  if (scrollFrame) return;
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0;
    syncScroll();
  });
}

/* ---------- Video sources ---------- */

function setVideoSource(source) {
  if (source === activeVideoSource) return;
  activeVideoSource = source;
  videoReady = false;
  // A different file starts at 0; clear the guard so the first scroll maps.
  lastSeekTime = -1;
  processVideo.classList.remove('is-unavailable');
  processVideo.src = source;
  processVideo.load();
}

function selectVideoSource() {
  if (isMobilePortrait) {
    if (isUseCanvas) return;
    setVideoSource('/media/film-mobile-916.mp4');
    return;
  }
  // Use lighter encode on phones/tablets to reduce GPU/decoder load.
  setVideoSource(filmSources[0].src);
}

function handleVideoMetadata() {
  if (Number.isFinite(processVideo.duration) && processVideo.duration > 0) {
    videoDuration = processVideo.duration;
    videoReady = true;
    lastSeekTime = -1;
    processVideo.pause();
    syncScroll();
  }
}

function handleVideoError() {
  // Step down a tier rather than showing no film at all.
  const index = filmSources.findIndex((film) => film.src === activeVideoSource);
  const next = index > 0 ? filmSources[index - 1].src : null;
  if (next) {
    setVideoSource(next);
    return;
  }
  processVideo.classList.add('is-unavailable');
}

function setReducedMotion() {
  isReducedMotion = motionQuery.matches;
  document.documentElement.classList.toggle('reduced-motion', isReducedMotion);
  if (isReducedMotion) {
    processVideo.pause();
    journeyStage.style.setProperty('--intro-opacity', '1');
  }
  // The jar is still built - reduced motion parks it at a three-quarter turn and
  // draws one frame, which is a better read of the jar than the old still was.
  jar3d?.setReducedMotion(isReducedMotion);
  scheduleScrollSync();
}

/* ---------- Cart ---------- */

function saveCart() {
  try {
    window.localStorage.setItem(cartStorageKey, JSON.stringify(cart));
    window.dispatchEvent(new CustomEvent('cart:updated'));
  } catch {
    cart = readCart();
  }
}

/* Both of these used to name the two ghee jars outright, so the landing page
   cart showed nothing for butter or curd even once they had been added
   elsewhere. They now read the whole catalogue like the shop page does. */
function getCartCount() {
  return countCartItems(cart);
}

function getCartTotal() {
  return totalCartValue(cart);
}

function renderCart() {
  const entries = Object.entries(cart).filter(([, quantity]) => quantity > 0);
  const count = getCartCount();
  cartItems.innerHTML = entries.map(([key, quantity]) => {
    const product = products[key];
    return `<div class="cart-item">
      <img src="${productImage(key)}" alt="" />
      <div class="cart-item__details">
        <p>${product.size}</p>
        <span>${currency.format(product.price)} each</span>
      </div>
      <div class="quantity-control" aria-label="Quantity for ${product.size}">
        <button type="button" data-cart-key="${key}" data-cart-action="decrease" aria-label="Decrease ${product.size}" ${quantity === 1 ? 'disabled' : ''}>−</button>
        <output aria-label="Quantity">${quantity}</output>
        <button type="button" data-cart-key="${key}" data-cart-action="increase" aria-label="Increase ${product.size}" ${quantity === 9 ? 'disabled' : ''}>+</button>
      </div>
      <button class="cart-item__remove" type="button" data-cart-key="${key}" data-cart-action="remove">Remove</button>
    </div>`;
  }).join('');
  const bothInCart = cart['half-litre'] > 0 && cart['one-litre'] > 0;
  addProductButtons.forEach((button) => {
    const key = button.dataset.addProduct;
    if (bothInCart && key in cart && cart[key] > 0) {
      button.textContent = 'In cart ✓';
      button.classList.add('is-in-cart');
    } else {
      button.textContent = 'Add to cart';
      button.classList.remove('is-in-cart');
    }
  });
  cartEmpty.hidden = entries.length > 0;
  cartTotal.textContent = currency.format(getCartTotal());
  cartCount.textContent = String(count);
  cartTrigger.hidden = count === 0;
  cartTrigger.setAttribute('aria-label', `Open cart with ${count} ${count === 1 ? 'item' : 'items'}`);
  checkoutButton.disabled = count === 0;
}

function openCart() {
  renderCart();
  if (typeof cartDialog.showModal === 'function') {
    if (!cartDialog.open) cartDialog.showModal();
  } else {
    cartDialog.setAttribute('open', '');
  }
}

function closeCart() {
  if (typeof cartDialog.close === 'function' && cartDialog.open) {
    cartDialog.close();
  } else {
    cartDialog.removeAttribute('open');
  }
}

function addToCart(productKey) {
  if (!(productKey in products)) return;
  cart[productKey] = clamp(cart[productKey] + 1, 1, 9);
  saveCart();
  renderCart();
}

function updateCart(event) {
  const button = event.target.closest('[data-cart-action]');
  if (!button) return;
  const productKey = button.dataset.cartKey;
  if (!(productKey in cart)) return;
  const action = button.dataset.cartAction;
  if (action === 'increase') cart[productKey] = clamp(cart[productKey] + 1, 0, 9);
  if (action === 'decrease') cart[productKey] = clamp(cart[productKey] - 1, 0, 9);
  if (action === 'remove') cart[productKey] = 0;
  saveCart();
  renderCart();
}

function continueToCheckout() {
  if (getCartCount() === 0) return;
  window.location.assign('/checkout.html');
}

function handleResize() {
  // The canvas backing store is sized immediately rather than on the debounce,
  // so a resize never leaves a stretched frame on screen for 100ms.
  jar3d?.resize();
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    selectVideoSource();
    scheduleScrollSync();
  }, 100);
}

/* ---------- Wiring ---------- */

processVideo.addEventListener('loadedmetadata', handleVideoMetadata);
processVideo.addEventListener('error', handleVideoError);
jarCanvas?.addEventListener('webglcontextlost', (event) => {
  // Without preventDefault the context is never restored, so the jar would be
  // left blank. Hand the space back to the still instead.
  event.preventDefault();
  if (jarFallback) jarFallback.hidden = false;
});
window.addEventListener('scroll', scheduleScrollSync, { passive: true });
window.addEventListener('resize', handleResize, { passive: true });
window.addEventListener('pagehide', () => window.cancelAnimationFrame(scrollFrame));
window.addEventListener('storage', (event) => {
  if (event.key !== cartStorageKey) return;
  cart = readCart();
  renderCart();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    processVideo.pause();
    jar3d?.setActive(false);
  } else {
    scheduleScrollSync();
  }
});
if (typeof motionQuery.addEventListener === 'function') {
  motionQuery.addEventListener('change', setReducedMotion);
}
addProductButtons.forEach((button) => {
  button.addEventListener('click', () => addToCart(button.dataset.addProduct));
});
cartTrigger.addEventListener('click', openCart);
closeCartButton.addEventListener('click', closeCart);
cartItems.addEventListener('click', updateCart);
checkoutButton.addEventListener('click', continueToCheckout);
cartDialog.addEventListener('click', (event) => {
  if (event.target === cartDialog) closeCart();
});

/* ---------- Boot ---------- */

selectVideoSource();
setReducedMotion();
renderCart();
startLoadingScreen();
preloadAssets();
window.addEventListener('load', finishLoading);
document.addEventListener('DOMContentLoaded', () => {
  if (assetsDone) finishLoading();
});
if (document.readyState !== 'loading' && assetsDone) finishLoading();
if (isReducedMotion) finishLoading();
syncScroll();
window.requestAnimationFrame(frame);
