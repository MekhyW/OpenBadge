import type { Scene, Animation, AdditionalLayer, Mood } from './types';
import { getCachedBlobUrl } from './config-loader';
import { applyLayerPlacement, layerZIndex } from './layer-layout';

interface QueueItem {
  animationId: string;
  repeatCount: number;
}

interface LayerState {
  key: string;
  source: string;
  visible: boolean;
  layerOrder: number;
  layerPriority: 'background' | 'foreground';
  playbackRate: number;
}

/**
 * Creates one <video> element per animation at startup, pre-buffers them all,
 * and swaps only visibility — no src changes during transitions means zero
 * blank frames.
 */
export class AnimationEngine {
  private scene: Scene;
  private animationMap: Map<string, Animation>;

  /** One pre-loaded <video> per animation id */
  private videoElements: Map<string, HTMLVideoElement> = new Map();
  /** One pre-loaded <video> per additional layer key */
  private layerVideoElements: Map<string, HTMLVideoElement> = new Map();
  private layerStates: Map<string, LayerState> = new Map();
  private animationPlaybackRates: Map<string, number> = new Map();
  private bgPlaybackRate: number = 1;
  private bgVideo: HTMLVideoElement;
  private container: HTMLElement;

  private currentAnimationId: string = '';
  private queue: QueueItem[] = [];
  private currentRepeat: number = 0;
  private endedHandler: (() => void) | null = null;
  private timeupdateHandler: (() => void) | null = null;
  private swapGeneration: number = 0;

  // Mood system
  private currentMoodId: string = '';
  private moodMap: Map<string, Mood> = new Map();
  private layerIdToKey: Map<string, string> = new Map();
  private moodDecayTimer: ReturnType<typeof setTimeout> | null = null;
  private moodChangeCallbacks: ((moodId: string) => void)[] = [];
  private moodSetByAnimation: boolean = false;
  private moodRandomTimers: ReturnType<typeof setTimeout>[] = [];

  // Rub interaction
  private rubState: 'none' | 'entering' | 'active' | 'exiting' = 'none';
  private rubAnimationId: string | null = null;
  private rubLoopCallbacks: ((animationId: string) => void)[] = [];
  private sceneChangeCallbacks: ((scene: Scene) => void)[] = [];

  /** Cancel callbacks for in-flight layer fades, keyed per element */
  private layerTransitionCancels: WeakMap<HTMLVideoElement, () => void> = new WeakMap();

  // Pre-warm system: wake the likely-next video before the swap deadline so
  // layer creation + first-frame decode never happen at the exact moment of
  // an animation transition (main source of dropped frames).
  private prewarmTimer: ReturnType<typeof setTimeout> | null = null;
  private warmupTokens: WeakMap<HTMLVideoElement, number> = new WeakMap();
  private warmupCounter: number = 0;

  /**
   * Videos a touch/rub can interrupt-to at any moment. They are never parked
   * out of the compositor: layer alive, frame 0 decoded, paused — so a tap
   * swaps instantly instead of cold-starting a decoder at the touch deadline.
   */
  private keepWarmIds: Set<string> = new Set();

  constructor(scene: Scene, bgVideo: HTMLVideoElement, container: HTMLElement) {
    this.scene = scene;
    this.bgVideo = bgVideo;
    this.container = container;

    this.animationMap = new Map();
    for (const anim of scene.animations) {
      this.animationMap.set(anim.id, anim);
      this.animationPlaybackRates.set(anim.id, 1);
    }

    for (const mood of scene.moods ?? []) {
      this.moodMap.set(mood.id, mood);
    }
    this.currentMoodId = scene.defaultMood ?? '';

    this.computeKeepWarmIds();
  }

  private computeKeepWarmIds(): void {
    this.keepWarmIds.clear();
    const defaultId = this.scene.defaultAnimation;

    const add = (id: string | undefined): void => {
      if (id && id !== defaultId && this.animationMap.has(id)) {
        this.keepWarmIds.add(id);
      }
    };

    for (const anim of this.scene.animations) {
      for (const trigger of anim.interactionTriggers ?? []) {
        if (trigger.type === 'touch') {
          // Touch interrupts jump straight to the animation itself
          add(anim.id);
        } else if (trigger.type === 'rub') {
          add(trigger.loopWhileActive
            ? this.transitionId(anim.entryTransition) ?? anim.id
            : anim.id);
        }
      }
    }

    // Touch triggers registered on additional layers target an animation
    for (const layer of this.scene.additionalLayers ?? []) {
      if (!layer.targetAnimation) continue;
      if ((layer.interactionTriggers ?? []).some((t) => t.type === 'touch')) {
        add(layer.targetAnimation);
      }
    }
  }

  private clampPlaybackRate(rate: number): number {
    return Math.max(0.25, Math.min(3, rate));
  }

  /**
   * Entry/exit transitions are normalized to animation-id strings by the
   * config loader; narrow the union for type-safe use.
   */
  private transitionId(transition: Animation['entryTransition']): string | undefined {
    return typeof transition === 'string' ? transition : undefined;
  }

  get currentAnimation(): string {
    return this.currentAnimationId;
  }

  get isIdle(): boolean {
    return (
      this.currentAnimationId === this.scene.defaultAnimation &&
      this.queue.length === 0
    );
  }

  get defaultAnimationId(): string {
    return this.scene.defaultAnimation;
  }

  get allAnimations(): Animation[] {
    return this.scene.animations;
  }

  get additionalLayers(): AdditionalLayer[] {
    return this.scene.additionalLayers ?? [];
  }

  get currentMood(): string {
    return this.currentMoodId;
  }

  get availableMoods(): string[] {
    return [...this.moodMap.keys()];
  }

  onMoodChange(callback: (moodId: string) => void): void {
    this.moodChangeCallbacks.push(callback);
  }

  onSceneChange(callback: (scene: Scene) => void): () => void {
    this.sceneChangeCallbacks.push(callback);
    return () => {
      const idx = this.sceneChangeCallbacks.indexOf(callback);
      if (idx >= 0) this.sceneChangeCallbacks.splice(idx, 1);
    };
  }

  getAdditionalLayerStates(): LayerState[] {
    return [...this.layerStates.values()]
      .sort((a, b) => {
        if (a.layerPriority !== b.layerPriority) {
          return a.layerPriority.localeCompare(b.layerPriority);
        }
        return a.layerOrder - b.layerOrder;
      });
  }

  /**
   * Promote a layer to its own GPU layer only for the duration of its opacity
   * transition, then drop the hint so it doesn't hold GPU memory forever.
   * When fading out (`willHide`), park it out of the compositor (display:none)
   * and pause it once the fade completes — but only if it's still hidden by
   * then. A paused park matters: an invisible VP9+alpha video would otherwise
   * keep a software decoder running indefinitely.
   */
  private beginLayerTransition(vid: HTMLVideoElement, willHide: boolean): void {
    // Cancel any previous pending fade handler so rapid toggles never apply
    // a stale end-state (e.g. pausing a layer that was re-shown mid-fade).
    this.layerTransitionCancels.get(vid)?.();

    vid.style.willChange = 'opacity';

    const cancel = (): void => {
      vid.removeEventListener('transitionend', finish);
      clearTimeout(timer);
      this.layerTransitionCancels.delete(vid);
    };

    const finish = (): void => {
      cancel();
      vid.style.willChange = '';
      if (willHide && vid.classList.contains('video-hidden')) {
        vid.style.display = 'none';
        vid.pause();
      }
    };

    vid.addEventListener('transitionend', finish);
    // Fallback in case transitionend never fires (no actual opacity change)
    const timer = window.setTimeout(finish, 2100);
    this.layerTransitionCancels.set(vid, cancel);
  }

  setAdditionalLayerVisible(layerKey: string, visible: boolean): void {
    const vid = this.layerVideoElements.get(layerKey);
    const state = this.layerStates.get(layerKey);
    if (!vid || !state) return;

    state.visible = visible;
    if (visible) {
      // Un-park before fading in so the first frame renders during the fade
      vid.style.display = '';
      this.beginLayerTransition(vid, false);
      vid.classList.remove('video-hidden');
      vid.classList.add('video-visible');
      vid.play().catch(console.warn);
      return;
    }

    this.beginLayerTransition(vid, true);
    vid.classList.remove('video-visible');
    vid.classList.add('video-hidden');
  }

  getBackgroundPlaybackRate(): number {
    return this.bgPlaybackRate;
  }

  setBackgroundPlaybackRate(rate: number): void {
    const nextRate = this.clampPlaybackRate(rate);
    this.bgPlaybackRate = nextRate;
    this.bgVideo.playbackRate = nextRate;
  }

  getAnimationPlaybackRate(animationId: string): number {
    return this.animationPlaybackRates.get(animationId) ?? 1;
  }

  setAnimationPlaybackRate(animationId: string, rate: number): void {
    const nextRate = this.clampPlaybackRate(rate);
    this.animationPlaybackRates.set(animationId, nextRate);
    const vid = this.videoElements.get(animationId);
    if (vid) vid.playbackRate = nextRate;
  }

  getAdditionalLayerPlaybackRate(layerKey: string): number {
    return this.layerStates.get(layerKey)?.playbackRate ?? 1;
  }

  setAdditionalLayerPlaybackRate(layerKey: string, rate: number): void {
    const nextRate = this.clampPlaybackRate(rate);
    const state = this.layerStates.get(layerKey);
    if (state) state.playbackRate = nextRate;
    const vid = this.layerVideoElements.get(layerKey);
    if (vid) vid.playbackRate = nextRate;
  }

  get currentQueue(): { animationId: string; repeatCount: number }[] {
    return [...this.queue];
  }

  get loadedVideoIds(): string[] {
    return [...this.videoElements.keys()];
  }

  getVideoReadyState(id: string): number {
    return this.videoElements.get(id)?.readyState ?? -1;
  }

  getVideoNativeSize(id: string): { width: number; height: number } | null {
    const vid = this.videoElements.get(id);
    if (!vid || !vid.videoWidth) return null;
    return { width: vid.videoWidth, height: vid.videoHeight };
  }

  get containerElement(): HTMLElement {
    return this.container;
  }

  setBackgroundOpacity(opacity: number): void {
    const clamped = Math.max(0, Math.min(1, opacity));
    this.bgVideo.style.opacity = String(clamped);
  }

  setCharacterAndLayersVisible(visible: boolean): void {
    // Character videos have no opacity transition — toggle display immediately.
    // Hidden characters are also paused: it stops their (software) decode and
    // prevents a pending `ended` from advancing the queue mid scene-transition,
    // which would un-hide the character over the portal overlay.
    for (const [, video] of this.videoElements) {
      video.classList.toggle('video-hidden', !visible);
      video.classList.toggle('video-visible', visible);
      video.style.display = visible ? '' : 'none';
      if (!visible) video.pause();
    }
    // Layers fade over 2s — keep them composited during the fade, then park.
    for (const [layerKey, video] of this.layerVideoElements) {
      if (visible) {
        video.style.display = '';
        if (this.layerStates.get(layerKey)?.visible) {
          video.play().catch(console.warn);
        }
      }
      this.beginLayerTransition(video, !visible);
      video.classList.toggle('video-hidden', !visible);
      video.classList.toggle('video-visible', visible);
    }
  }

  async waitForCurrentAnimationVisible(timeoutMs: number = 2000): Promise<boolean> {
    const startedAt = performance.now();

    return new Promise((resolve) => {
      const check = (): void => {
        const currentVideo = this.videoElements.get(this.currentAnimationId);
        if (currentVideo?.classList.contains('video-visible')) {
          resolve(true);
          return;
        }

        if (performance.now() - startedAt >= timeoutMs) {
          resolve(false);
          return;
        }

        requestAnimationFrame(check);
      };

      requestAnimationFrame(check);
    });
  }

  getAnimation(id: string): Animation | undefined {
    return this.animationMap.get(id);
  }

  /**
   * Resolve every video to a cached blob URL (fetched at most once per app
   * run), create a <video> per animation, append to the container, and wait
   * until all report canplaythrough.
   */
  async preloadAll(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const anim of this.scene.animations) {
      const p = getCachedBlobUrl(anim.source)
        .then((blobUrl) => {
          const video = document.createElement('video');
          video.src = blobUrl;
          video.preload = 'auto';
          video.playsInline = true;
          video.muted = true;
          video.disablePictureInPicture = true;
          video.disableRemotePlayback = true;
          video.loop = false;
          video.playbackRate = this.getAnimationPlaybackRate(anim.id);
          video.classList.add('character-video', 'video-hidden');
          video.style.zIndex = '10';
          // Park hidden character videos out of the compositor until needed
          video.style.display = 'none';
          this.container.appendChild(video);
          this.videoElements.set(anim.id, video);

          return new Promise<void>((resolve) => {
            if (video.readyState >= 4) {
              resolve();
              return;
            }
            video.addEventListener('canplaythrough', () => resolve(), {
              once: true,
            });
            video.load();
          });
        });

      promises.push(p);
    }

    // Also preload the background from the shared cache
    const bgPromise = getCachedBlobUrl(this.scene.background.source)
      .then((blobUrl) => {
        this.bgVideo.src = blobUrl;
        this.bgVideo.preload = 'auto';
        this.bgVideo.playbackRate = this.bgPlaybackRate;
        return new Promise<void>((resolve) => {
          if (this.bgVideo.readyState >= 4) {
            resolve();
            return;
          }
          this.bgVideo.addEventListener('canplaythrough', () => resolve(), {
            once: true,
          });
          this.bgVideo.load();
        });
      });
    promises.push(bgPromise);

    // Preload additional layers
    for (const [index, layer] of (this.scene.additionalLayers ?? []).entries()) {
      const layerKey = `${this.scene.id}:${index}`;
      const layerRate = this.layerStates.get(layerKey)?.playbackRate ?? 1;
      const zIndex = layerZIndex(layer);

      const layerPromise = getCachedBlobUrl(layer.source)
        .then((blobUrl) => {
          const video = document.createElement('video');
          video.src = blobUrl;
          video.preload = 'auto';
          video.playsInline = true;
          video.muted = true;
          video.disablePictureInPicture = true;
          video.disableRemotePlayback = true;
          video.loop = layer.loop;
          video.playbackRate = layerRate;
          video.classList.add('layer-video', 'video-hidden');
          video.style.zIndex = String(zIndex);
          video.style.display = 'none';
          video.style.background = 'transparent';
          applyLayerPlacement(video, layer);

          this.container.appendChild(video);
          this.layerVideoElements.set(layerKey, video);
          if (layer.id) {
            this.layerIdToKey.set(layer.id, layerKey);
          }
          this.layerStates.set(layerKey, {
            key: layerKey,
            source: layer.source,
            visible: true,
            layerOrder: layer.layerOrder,
            layerPriority: layer.layerPriority,
            playbackRate: layerRate,
          });

          return new Promise<void>((resolve) => {
            if (video.readyState >= 4) {
              resolve();
              return;
            }
            video.addEventListener('canplaythrough', () => resolve(), {
              once: true,
            });
            video.load();
          });
        });

      promises.push(layerPromise);
    }

    // Track progress for each loaded asset
    const total = promises.length;
    let loaded = 0;
    const tracked = promises.map(p => p.then(() => {
      loaded++;
      onProgress?.(loaded, total);
    }));
    await Promise.all(tracked);
  }

  start(): void {
    // Start background
    this.bgVideo.loop = this.scene.background.loop;
    this.bgVideo.play().catch(console.warn);

    // Start additional layers
    for (const [layerKey, vid] of this.layerVideoElements) {
      const state = this.layerStates.get(layerKey);
      if (!state || !state.visible) {
        vid.classList.remove('video-visible');
        vid.classList.add('video-hidden');
        vid.style.display = 'none';
        continue;
      }

      // Un-park and fade in
      vid.style.display = '';
      this.beginLayerTransition(vid, false);
      vid.play().then(() => {
        if (!state.visible) return;
        vid.classList.remove('video-hidden');
        vid.classList.add('video-visible');
      }).catch(console.warn);
    }

    // Show and play the default idle animation
    this.showVideo(this.scene.defaultAnimation, true);

    // Keep touch/rub-interruptible videos warm so taps swap instantly
    this.warmKeepWarmVideos();

    // Apply default mood effects
    if (this.currentMoodId) {
      const mood = this.moodMap.get(this.currentMoodId);
      if (mood) this.applyMoodEffects(mood).catch(console.warn);
    }

    // Setup mood random triggers (e.g. happy mood activates randomly)
    this.setupMoodRandomTriggers();
  }

  triggerAnimation(animationId: string): void {
    const anim = this.animationMap.get(animationId);
    if (!anim) return;

    const items: QueueItem[] = [];

    const entryId = this.transitionId(anim.entryTransition);
    const exitId = this.transitionId(anim.exitTransition);
    if (entryId) {
      items.push({ animationId: entryId, repeatCount: 1 });
    }
    items.push({ animationId: anim.id, repeatCount: anim.loopCount ?? 1 });
    if (exitId) {
      items.push({ animationId: exitId, repeatCount: 1 });
    }

    this.queue = items;
    this.playNextInQueue();
  }

  interruptWith(animationId: string): void {
    this.clearQueue();
    // showVideo handles hiding the previous video and cleaning up handlers
    this.showVideo(animationId, false);
  }

  /**
   * Wait for the current animation (or cycle) to finish, then play the
   * requested animation. If a queue is already in progress the items are
   * appended; otherwise the current video's loop is disabled so it ends
   * naturally and the queue picks up from there.
   */
  triggerWhenIdle(animationId: string): void {
    const anim = this.animationMap.get(animationId);
    if (!anim) return;

    const items: QueueItem[] = [];
    const entryId = this.transitionId(anim.entryTransition);
    const exitId = this.transitionId(anim.exitTransition);
    if (entryId) {
      items.push({ animationId: entryId, repeatCount: 1 });
    }
    items.push({ animationId: anim.id, repeatCount: anim.loopCount ?? 1 });
    if (exitId) {
      items.push({ animationId: exitId, repeatCount: 1 });
    }

    if (this.queue.length > 0) {
      // A sequence is already playing — append so it runs after
      this.queue.push(...items);
      return;
    }

    // While rub interaction is active, never touch current handlers/video flow.
    // Keep requested items queued and let rub end naturally first.
    if (this.rubState !== 'none') {
      this.queue = items;
      this.prewarmQueuedFirst();
      return;
    }

    // Queue is empty (idle / default loop). Set the queue and let the
    // current video finish its cycle before advancing. The idle cycle gives
    // plenty of headroom to warm the first queued video ahead of the swap.
    this.queue = items;
    this.prewarmQueuedFirst();

    const currentVid = this.videoElements.get(this.currentAnimationId);
    if (!currentVid) {
      this.playNextInQueue();
      return;
    }

    // Clean up any existing handlers on the current video
    this.removeEndedHandler();
    this.removeTimeupdateHandler(currentVid);

    // Stop looping so the current cycle ends naturally
    if (currentVid.loop) {
      currentVid.loop = false;
    }

    // When the current cycle finishes, start playing the queue
    this.endedHandler = () => {
      this.removeEndedHandler();
      this.playNextInQueue();
    };
    currentVid.addEventListener('ended', this.endedHandler);
  }

  // ─── Private ───────────────────────────────────────────────

  private clearQueue(): void {
    this.queue = [];
    this.currentRepeat = 0;
  }

  private removeEndedHandler(): void {
    if (this.endedHandler) {
      const vid = this.videoElements.get(this.currentAnimationId);
      vid?.removeEventListener('ended', this.endedHandler);
      this.endedHandler = null;
    }
  }

  private removeTimeupdateHandler(vid?: HTMLVideoElement): void {
    if (this.timeupdateHandler) {
      const v = vid ?? this.videoElements.get(this.currentAnimationId);
      v?.removeEventListener('timeupdate', this.timeupdateHandler);
      this.timeupdateHandler = null;
    }
  }

  /**
   * Warm a parked video before it is needed: re-attach it to the compositor,
   * rewind, and run the decoder for one frame (then pause + rewind). The next
   * showVideo() then resumes a hot pipeline instead of cold-starting layer
   * creation + first-frame decode at the swap deadline. Same trick the scene
   * transitions use for the portal pool.
   */
  private warmUpVideo(vid: HTMLVideoElement): void {
    const token = ++this.warmupCounter;
    this.warmupTokens.set(vid, token);

    vid.style.display = '';
    if (vid.currentTime !== 0) vid.currentTime = 0;

    const playPromise = vid.play();
    if (!playPromise) return;
    playPromise
      .then(() => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          // Superseded by real playback (or a newer warm-up) — leave it alone
          if (this.warmupTokens.get(vid) !== token) return;
          vid.pause();
          if (vid.currentTime !== 0) vid.currentTime = 0;
        };
        if ('requestVideoFrameCallback' in vid) {
          (vid as any).requestVideoFrameCallback(() => settle());
        }
        // Fallback: rVFC never fires on hidden/stalled pages — a warm-up
        // video must never be left playing.
        setTimeout(settle, 500);
      })
      .catch(() => { /* warm-up is best-effort */ });
  }

  /** Figure out which animation likely plays after the current one and warm it. */
  private prewarmSuccessor(): void {
    const currentId = this.currentAnimationId;

    let nextId: string | undefined;
    if (this.rubState === 'entering' && this.rubAnimationId) {
      nextId = this.rubAnimationId;
    } else if (this.rubState === 'active' && this.rubAnimationId) {
      const anim = this.animationMap.get(this.rubAnimationId);
      nextId = this.transitionId(anim?.exitTransition) ?? this.scene.defaultAnimation;
    } else if (this.queue.length > 0 && this.queue[0].animationId === currentId) {
      nextId = this.queue[1]?.animationId ?? this.scene.defaultAnimation;
    } else {
      nextId = this.scene.defaultAnimation;
    }

    if (!nextId || nextId === currentId) return;
    const nextVid = this.videoElements.get(nextId);
    if (!nextVid || !nextVid.paused) return;
    this.warmUpVideo(nextVid);
  }

  /** Warm the first queued video while the current cycle finishes. */
  private prewarmQueuedFirst(): void {
    const first = this.queue[0];
    if (!first || first.animationId === this.currentAnimationId) return;
    const vid = this.videoElements.get(first.animationId);
    if (!vid || !vid.paused) return;
    this.warmUpVideo(vid);
  }

  /** Bring every touch/rub-interruptible video to the warm-parked state. */
  private warmKeepWarmVideos(): void {
    for (const id of this.keepWarmIds) {
      if (id === this.currentAnimationId) continue;
      const vid = this.videoElements.get(id);
      if (!vid || !vid.paused) continue;
      this.warmUpVideo(vid);
    }
  }

  /**
   * After a keep-warm video was used it is left paused mid-way by the hide
   * pass; rewind it (off the swap frame) so its frame-0 texture is ready for
   * the next tap.
   */
  private reprimeKeepWarmVideos(): void {
    for (const id of this.keepWarmIds) {
      if (id === this.currentAnimationId) continue;
      const vid = this.videoElements.get(id);
      if (!vid || !vid.paused || vid.style.display === 'none') continue;
      if (vid.currentTime !== 0) vid.currentTime = 0;
    }
  }

  /**
   * Atomically switch to a pre-loaded video with zero blank frames.
   * The previous video stays visible until the new one has a confirmed
   * rendered frame, then all other videos are hidden.
   */
  private showVideo(animationId: string, isLoop: boolean, repeatCount: number = 1): void {
    const generation = ++this.swapGeneration;
    const prevId = this.currentAnimationId;
    const prevVid = this.videoElements.get(prevId);

    // Clean up all handlers from previous video
    if (this.endedHandler && prevVid) {
      prevVid.removeEventListener('ended', this.endedHandler);
      this.endedHandler = null;
    }
    this.removeTimeupdateHandler(prevVid ?? undefined);

    const anim = this.animationMap.get(animationId);
    const vid = this.videoElements.get(animationId);
    if (!anim || !vid) return;

    // Cancel pending prewarm scheduling and invalidate any in-flight warm-up
    // on this element so it cannot pause the real playback started below.
    if (this.prewarmTimer) {
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = null;
    }
    this.warmupTokens.set(vid, ++this.warmupCounter);

    // Free the previous video's (software) decode stream right away: it
    // freezes on its current frame — imperceptible for the subtle idle loop,
    // a no-op for videos that already ended — instead of competing with the
    // new video's decoder spin-up. It stays visible until the swap.
    if (prevVid && prevVid !== vid) {
      prevVid.pause();
    }

    // A warm target (already in the compositor, rewound, data buffered) can
    // be revealed in the same frame as the trigger — its frame-0 texture is
    // ready, so there is nothing to wait for.
    const canRevealInstantly =
      vid.style.display === '' &&
      !vid.seeking &&
      vid.currentTime === 0 &&
      vid.readyState >= 2;

    // Apply mood change if this animation triggers one (temporary, while animation plays)
    if (anim.setsMood) {
      this.moodSetByAnimation = true;
      if (this.moodDecayTimer) {
        clearTimeout(this.moodDecayTimer);
        this.moodDecayTimer = null;
      }
      this.setMood(anim.setsMood).catch(console.warn);
    }

    // Place new video above all others during the transition.
    // Un-park it so it can decode/render its first frame while still hidden.
    vid.style.zIndex = '11';
    vid.style.display = '';

    const revealNew = (): void => {
      // Skip if a newer showVideo call has superseded this one
      if (generation !== this.swapGeneration) return;
      vid.classList.remove('video-hidden');
      vid.classList.add('video-visible');
    };

    // Hiding the previous video is always gated on the new video's first
    // presented frame, keeping one extra frame of overlap — this avoids
    // compositor timing gaps (and blank frames) on slower devices.
    const hideOthers = (): void => {
      if (generation !== this.swapGeneration) return;
      requestAnimationFrame(() => {
        if (generation !== this.swapGeneration) return;

        // Hide all other videos — robust against rapid successive calls.
        // Already-parked videos are skipped: touching them again would add
        // style work at the busiest moment of the swap. Rewinding is lazy
        // (done right before the next play) for the same reason.
        for (const [id, otherVid] of this.videoElements) {
          if (id === animationId) continue;
          if (otherVid.style.display === 'none') continue;
          otherVid.classList.remove('video-visible');
          otherVid.classList.add('video-hidden');
          otherVid.pause();
          otherVid.style.zIndex = '10';
          // Park out of the compositor (character videos have no opacity
          // fade) — except touch/rub targets, which must stay warm.
          if (!this.keepWarmIds.has(id)) {
            otherVid.style.display = 'none';
          }
        }
        vid.style.zIndex = '10';

        // Once the swap has settled, warm whichever video likely plays next
        // and re-prime used touch/rub targets
        this.prewarmTimer = setTimeout(() => {
          this.prewarmTimer = null;
          if (generation !== this.swapGeneration) return;
          this.prewarmSuccessor();
          this.reprimeKeepWarmVideos();
        }, 150);
      });
    };

    this.currentAnimationId = animationId;

    // ── Normal (forward) playback ──
    if (vid.currentTime !== 0) vid.currentTime = 0;
    vid.loop = isLoop && anim.loop && !anim.loopCount;

    // For finite repeats > 1, use native loop for gapless playback
    // and count iterations via timeupdate (more reliable than seeked)
    const needsRepeatTracking = !vid.loop && repeatCount > 1;
    if (needsRepeatTracking) {
      vid.loop = true;
    }

    // Start decoding frames while still hidden (opacity 0)
    const playPromise = vid.play();

    const gateOnFirstFrame = (after: () => void): void => {
      if (playPromise) {
        playPromise.then(() => {
          if (generation !== this.swapGeneration) return;
          // Decoder is active — wait for an actual rendered frame
          if ('requestVideoFrameCallback' in vid) {
            (vid as any).requestVideoFrameCallback(() => after());
          } else {
            requestAnimationFrame(() => after());
          }
        }).catch(console.warn);
      } else {
        after();
      }
    };

    if (canRevealInstantly) {
      // Frame 0 is already textured: swap in the same frame as the trigger.
      // If the pipeline was suspended and paints nothing for an instant, the
      // frozen previous video still shows underneath until the first frame.
      revealNew();
      gateOnFirstFrame(hideOthers);
    } else {
      gateOnFirstFrame(() => {
        revealNew();
        hideOthers();
      });
    }

    // Set up completion handling
    if (needsRepeatTracking) {
      // Count loop wraps via timeupdate — detect currentTime jumping backwards
      let lastTime = 0;
      let wraps = 0;
      const neededWraps = repeatCount - 1; // e.g. 4 plays = 3 wraps

      const onTimeUpdate = (): void => {
        if (lastTime > 0.5 && vid.currentTime < lastTime - 0.5) {
          wraps++;
          if (wraps >= neededWraps) {
            vid.removeEventListener('timeupdate', onTimeUpdate);
            this.timeupdateHandler = null;
            vid.loop = false;
            // Register ended handler NOW so the last play triggers queue advance
            this.endedHandler = () => this.onVideoEnded();
            vid.addEventListener('ended', this.endedHandler);
          }
        }
        lastTime = vid.currentTime;
      };

      this.timeupdateHandler = onTimeUpdate;
      vid.addEventListener('timeupdate', onTimeUpdate);
    } else if (!vid.loop) {
      // Single-play animation or transition
      this.endedHandler = () => this.onVideoEnded();
      vid.addEventListener('ended', this.endedHandler);
    }
    // Infinite loop: no ended handler needed
  }

  private playNextInQueue(): void {
    if (this.queue.length === 0) {
      // Revert mood if it was set by an animation
      this.revertAnimationMood();
      // Return to idle — showVideo handles hiding previous
      this.showVideo(this.scene.defaultAnimation, true);
      return;
    }

    const item = this.queue[0];
    this.currentRepeat = 0;

    // showVideo handles hiding previous video with zero-gap swap
    this.showVideo(item.animationId, false, item.repeatCount);
  }

  private onVideoEnded(): void {
    this.removeEndedHandler();
    this.removeTimeupdateHandler();

    // Handle rub state machine
    if (this.rubState === 'entering' && this.rubAnimationId) {
      // Entry transition finished → start the rub animation loop
      this.rubState = 'active';
      this.showVideo(this.rubAnimationId, false);
      return;
    }

    if (this.rubState === 'active' && this.rubAnimationId) {
      for (const cb of this.rubLoopCallbacks) {
        cb(this.rubAnimationId);
      }
      // Animation ended while still rubbing — restart it
      const vid = this.videoElements.get(this.rubAnimationId);
      if (vid) {
        vid.currentTime = 0;
        vid.play().catch(console.warn);
        this.endedHandler = () => this.onVideoEnded();
        vid.addEventListener('ended', this.endedHandler);
      }
      return;
    }

    if (this.rubState === 'exiting') {
      const anim = this.rubAnimationId ? this.animationMap.get(this.rubAnimationId) : null;
      const exitId = this.transitionId(anim?.exitTransition);
      // If the exit transition hasn't played yet, play it now
      if (exitId && this.currentAnimationId !== exitId) {
        this.showVideo(exitId, false);
        return;
      }
      // Exit transition finished (or none) → return to idle
      this.rubState = 'none';
      this.rubAnimationId = null;
      this.revertAnimationMood();
      if (this.queue.length > 0) {
        this.playNextInQueue();
      } else {
        this.showVideo(this.scene.defaultAnimation, true);
      }
      return;
    }

    // Advance queue (repeats are handled by native loop in showVideo)
    if (this.queue.length > 0) {
      this.queue.shift();
      this.currentRepeat = 0;
    }

    // playNextInQueue handles empty queue → idle
    this.playNextInQueue();
  }

  // ─── Rub interaction ────────────────────────────────────────

  startRubAnimation(animationId: string): void {
    const anim = this.animationMap.get(animationId);
    if (!anim) return;

    this.rubAnimationId = animationId;
    this.clearQueue();

    const entryId = this.transitionId(anim.entryTransition);

    // If already playing this animation (e.g. from a touch trigger),
    // just switch to rub active mode without re-triggering entry
    if (this.currentAnimationId === animationId ||
      (entryId && this.currentAnimationId === entryId)) {
      this.rubState = 'active';
      return;
    }

    if (entryId) {
      this.rubState = 'entering';
      this.showVideo(entryId, false);
    } else {
      this.rubState = 'active';
      this.showVideo(animationId, false);
    }
  }

  stopRubAnimation(): void {
    if (this.rubState === 'none') return;

    const anim = this.rubAnimationId ? this.animationMap.get(this.rubAnimationId) : null;

    if (this.rubState === 'entering') {
      // Entry transition still playing — let it finish, then go to exit
      this.rubState = 'exiting';
      return;
    }

    this.rubState = 'exiting';

    const exitId = this.transitionId(anim?.exitTransition);
    if (exitId) {
      this.showVideo(exitId, false);
    } else {
      this.rubState = 'none';
      this.rubAnimationId = null;
      this.revertAnimationMood();
      if (this.queue.length > 0) {
        this.playNextInQueue();
      } else {
        this.showVideo(this.scene.defaultAnimation, true);
      }
    }
  }

  get isRubActive(): boolean {
    return this.rubState !== 'none';
  }

  onRubLoop(callback: (animationId: string) => void): () => void {
    this.rubLoopCallbacks.push(callback);
    return () => {
      const idx = this.rubLoopCallbacks.indexOf(callback);
      if (idx >= 0) this.rubLoopCallbacks.splice(idx, 1);
    };
  }

  // ─── Mood system ───────────────────────────────────────────

  async setMood(moodId: string): Promise<void> {
    if (this.currentMoodId === moodId) return;

    const mood = this.moodMap.get(moodId);
    if (!mood) return;

    this.currentMoodId = moodId;
    await this.applyMoodEffects(mood);

    for (const cb of this.moodChangeCallbacks) {
      cb(moodId);
    }
  }

  private revertAnimationMood(): void {
    if (!this.moodSetByAnimation) return;
    this.moodSetByAnimation = false;
    const defaultMoodId = this.scene.defaultMood;
    if (defaultMoodId && this.currentMoodId !== defaultMoodId) {
      this.setMood(defaultMoodId).catch(console.warn);
    }
  }

  private activateTemporaryMood(moodId: string, duration: number): void {
    // Animation-set mood has priority
    if (this.moodSetByAnimation) return;

    if (this.moodDecayTimer) {
      clearTimeout(this.moodDecayTimer);
      this.moodDecayTimer = null;
    }

    this.setMood(moodId).catch(console.warn);

    this.moodDecayTimer = setTimeout(() => {
      this.moodDecayTimer = null;
      if (this.moodSetByAnimation) return;
      const defaultMoodId = this.scene.defaultMood;
      if (defaultMoodId && this.currentMoodId === moodId) {
        this.setMood(defaultMoodId).catch(console.warn);
      }
    }, duration);
  }

  private setupMoodRandomTriggers(): void {
    this.clearMoodRandomTimers();

    for (const [moodId, mood] of this.moodMap) {
      // Don't randomly trigger the default mood
      if (moodId === (this.scene.defaultMood ?? '')) continue;

      for (const trigger of mood.interactionTriggers ?? []) {
        if (trigger.type === 'random' && trigger.timeRange && trigger.duration) {
          const { min, max } = trigger.timeRange;
          const duration = trigger.duration;

          const scheduleNext = (): void => {
            const delay = min + Math.random() * (max - min);
            const timer = setTimeout(() => {
              const idx = this.moodRandomTimers.indexOf(timer);
              if (idx >= 0) this.moodRandomTimers.splice(idx, 1);
              this.activateTemporaryMood(moodId, duration);
              scheduleNext();
            }, delay);
            this.moodRandomTimers.push(timer);
          };

          scheduleNext();
        }
      }
    }
  }

  private clearMoodRandomTimers(): void {
    for (const timer of this.moodRandomTimers) {
      clearTimeout(timer);
    }
    this.moodRandomTimers.length = 0;
  }

  private async applyMoodEffects(mood: Mood): Promise<void> {
    for (const override of mood.setAnimations ?? []) {
      // Try as additional layer first (by layer id)
      const layerKey = this.layerIdToKey.get(override.animation);
      if (layerKey) {
        if (override.speed !== undefined) {
          this.setAdditionalLayerPlaybackRate(layerKey, override.speed);
        }
        if (override.source) {
          await this.updateLayerSource(layerKey, override.source);
        }
        continue;
      }

      // Try as animation
      if (this.animationMap.has(override.animation)) {
        if (override.speed !== undefined) {
          this.setAnimationPlaybackRate(override.animation, override.speed);
        }
        if (override.source) {
          await this.updateAnimationSource(override.animation, override.source);
        }
      }
    }
  }

  private async updateLayerSource(layerKey: string, source: string): Promise<void> {
    const vid = this.layerVideoElements.get(layerKey);
    if (!vid) return;

    const blobUrl = await getCachedBlobUrl(source).catch(() => null);
    if (!blobUrl) return;

    // Previous src stays alive in the shared cache — never revoke it
    vid.src = blobUrl;
    vid.load();

    await new Promise<void>((resolve) => {
      if (vid.readyState >= 4) { resolve(); return; }
      vid.addEventListener('canplaythrough', () => resolve(), { once: true });
    });

    vid.play().catch(console.warn);
    const state = this.layerStates.get(layerKey);
    if (state) state.source = source;
  }

  private async updateAnimationSource(animationId: string, source: string): Promise<void> {
    const vid = this.videoElements.get(animationId);
    if (!vid) return;

    const blobUrl = await getCachedBlobUrl(source).catch(() => null);
    if (!blobUrl) return;

    const wasPlaying = !vid.paused;
    vid.pause();
    // Previous src stays alive in the shared cache — never revoke it
    vid.src = blobUrl;
    vid.load();

    await new Promise<void>((resolve) => {
      if (vid.readyState >= 4) { resolve(); return; }
      vid.addEventListener('canplaythrough', () => resolve(), { once: true });
    });

    if (wasPlaying) vid.play().catch(console.warn);
    const anim = this.animationMap.get(animationId);
    if (anim) anim.source = source;
  }

  /**
   * Tear down current scene: stop all videos and remove dynamically-created
   * <video> elements, then load a new scene. Blob URLs are shared via the
   * global cache and intentionally kept alive, so revisiting a scene is
   * fetch-free.
   */
  async switchScene(newScene: Scene, autoStart: boolean = true): Promise<void> {
    // Stop & clean up current videos
    this.clearQueue();
    this.removeEndedHandler();
    this.removeTimeupdateHandler();
    if (this.prewarmTimer) {
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = null;
    }

    // Clean up mood state
    if (this.moodDecayTimer) {
      clearTimeout(this.moodDecayTimer);
      this.moodDecayTimer = null;
    }
    this.clearMoodRandomTimers();
    this.moodSetByAnimation = false;
    this.moodMap.clear();
    this.layerIdToKey.clear();
    this.rubState = 'none';
    this.rubAnimationId = null;

    for (const [, vid] of this.videoElements) {
      vid.pause();
      vid.remove();
    }
    this.videoElements.clear();

    // Clean up additional layers
    for (const [, vid] of this.layerVideoElements) {
      vid.pause();
      vid.remove();
    }
    this.layerVideoElements.clear();
    this.layerStates.clear();

    // Clean up background (detach so the decoder is released between scenes)
    this.bgVideo.pause();
    this.bgVideo.removeAttribute('src');

    // Set up new scene
    this.scene = newScene;
    this.animationMap = new Map();
    const nextPlaybackRates = new Map<string, number>();
    for (const anim of newScene.animations) {
      this.animationMap.set(anim.id, anim);
      nextPlaybackRates.set(anim.id, this.animationPlaybackRates.get(anim.id) ?? 1);
    }
    this.animationPlaybackRates = nextPlaybackRates;
    this.currentAnimationId = '';

    for (const mood of newScene.moods ?? []) {
      this.moodMap.set(mood.id, mood);
    }
    this.currentMoodId = newScene.defaultMood ?? '';

    this.computeKeepWarmIds();

    await this.preloadAll();
    if (autoStart) {
      this.start();
    } else {
      // Start background only so fade-in works, but keep character/layers hidden
      this.bgVideo.loop = this.scene.background.loop;
      this.bgVideo.play().catch(console.warn);
    }

    for (const cb of this.sceneChangeCallbacks) {
      cb(this.scene);
    }
  }

  get sceneId(): string {
    return this.scene.id;
  }

  pause(): void {
    this.clearQueue();
    this.clearMoodRandomTimers();
    if (this.prewarmTimer) {
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = null;
    }
    if (this.moodDecayTimer) {
      clearTimeout(this.moodDecayTimer);
      this.moodDecayTimer = null;
    }
    this.bgVideo.pause();
    for (const vid of this.videoElements.values()) vid.pause();
    for (const vid of this.layerVideoElements.values()) vid.pause();
  }

  resume(): void {
    this.bgVideo.play().catch(console.warn);
    const currentVid = this.videoElements.get(this.currentAnimationId);
    if (currentVid) currentVid.play().catch(console.warn);
    for (const [layerKey, vid] of this.layerVideoElements) {
      const state = this.layerStates.get(layerKey);
      if (state?.visible) vid.play().catch(console.warn);
    }
    this.setupMoodRandomTriggers();
  }
}
