import { SplashScreen } from '@capacitor/splash-screen';
import type { Scene, SceneDuration, TransitionSource } from './types';
import { loadAnimationConfig, getCachedBlobUrl, prefetchAllSceneAssets } from './config-loader';
import { AnimationEngine } from './animation-engine';
import { setupTouchTriggers, setupRandomTriggers, setupRubTriggers } from './triggers';
import { createDebugPanel } from './debug-panel';
import { loadProfile } from './profile-store';
import { applyProfileAnimations, mountBadgeUi } from './badge-ui';

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function getSceneDuration(scene: Scene): SceneDuration | null {
  const duration = scene.sceneDuration;
  if (!duration) return null;
  if (!Number.isFinite(duration.min) || !Number.isFinite(duration.max)) return null;
  if (duration.min <= 0 || duration.max <= 0 || duration.max < duration.min) return null;
  return duration;
}

/**
 * Fade the background via a one-shot CSS transition: the compositor animates
 * opacity with no per-frame JS work, which keeps the main thread free during
 * scene transitions — exactly when the portal videos need it most.
 */
async function fadeBackgroundTo(engine: AnimationEngine, target: number, durationMs: number): Promise<void> {
  const clampedTarget = Math.max(0, Math.min(1, target));
  const bgVideo = document.getElementById('bg-video') as HTMLElement;
  const startOpacity = Number.parseFloat(getComputedStyle(bgVideo).opacity || '1');

  if (durationMs <= 0 || Math.abs(startOpacity - clampedTarget) < 0.001) {
    engine.setBackgroundOpacity(clampedTarget);
    return;
  }

  return new Promise((resolve) => {
    let timer = 0;
    const finish = (): void => {
      clearTimeout(timer);
      bgVideo.removeEventListener('transitionend', onEnd);
      bgVideo.style.transition = '';
      engine.setBackgroundOpacity(clampedTarget);
      resolve();
    };
    const onEnd = (e: TransitionEvent): void => {
      if (e.propertyName === 'opacity') finish();
    };

    bgVideo.addEventListener('transitionend', onEnd);
    // Fallback in case transitionend never fires
    timer = window.setTimeout(finish, durationMs + 250);

    bgVideo.style.opacity = String(startOpacity);
    bgVideo.style.transition = `opacity ${durationMs}ms linear`;
    // Flush styles so the transition starts from the current opacity
    void bgVideo.offsetWidth;
    engine.setBackgroundOpacity(clampedTarget);
  });
}

interface TransitionPlayback {
  durationMs: number;
  ended: Promise<void>;
  play: () => Promise<void>;
  cleanup: () => void;
}

interface TransitionVideoHandle {
  source: string;
  video: HTMLVideoElement;
}

const transitionVideoPool = new Map<string, HTMLVideoElement[]>();
const transitionVideosInUse = new WeakSet<HTMLVideoElement>();

async function prepareTransitionVideo(
  container: HTMLElement,
  transition: TransitionSource | undefined,
): Promise<TransitionPlayback | null> {
  if (!transition?.source) return null;

  const handle = await acquireTransitionVideo(container, transition.source);
  const { source, video } = handle;

  const durationMs = Number.isFinite(video.duration) && video.duration > 0
    ? video.duration * 1000
    : 0;

  const ended = new Promise<void>((resolve) => {
    video.addEventListener('ended', () => resolve(), { once: true });
  });

  return {
    durationMs,
    ended,
    play: async () => {
      await video.play();

      await new Promise<void>((resolve) => {
        const reveal = (): void => {
          video.classList.remove('video-hidden');
          video.classList.add('video-visible');
          resolve();
        };

        if ('requestVideoFrameCallback' in video) {
          (video as any).requestVideoFrameCallback(() => reveal());
        } else {
          requestAnimationFrame(() => reveal());
        }
      });
    },
    cleanup: () => {
      video.pause();
      releaseTransitionVideo(source, video);
    },
  };
}

async function createTransitionVideo(container: HTMLElement, source: string): Promise<HTMLVideoElement> {
  const blobUrl = await getCachedBlobUrl(source);

  const video = document.createElement('video');
  video.src = blobUrl;
  video.preload = 'auto';
  video.playsInline = true;
  video.muted = true;
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.loop = false;
  video.classList.add('character-video', 'scene-transition-video', 'video-hidden');
  video.style.zIndex = '30';

  container.appendChild(video);

  await new Promise<void>((resolve) => {
    if (video.readyState >= 4) {
      resolve();
      return;
    }
    video.addEventListener('canplaythrough', () => resolve(), { once: true });
    video.load();
  });

  try {
    await video.play();
    video.pause();
    video.currentTime = 0;
  } catch {
    // Decoder warm-up can fail on some devices/browsers; transitions still work.
  }

  // Park pooled transition videos out of the compositor while unused
  video.style.display = 'none';

  return video;
}

async function acquireTransitionVideo(container: HTMLElement, source: string): Promise<TransitionVideoHandle> {
  const bucket = transitionVideoPool.get(source) ?? [];

  let selected = bucket.find((video) => !transitionVideosInUse.has(video));
  if (!selected) {
    selected = await createTransitionVideo(container, source);
    bucket.push(selected);
    transitionVideoPool.set(source, bucket);
  }

  transitionVideosInUse.add(selected);

  selected.pause();
  selected.currentTime = 0;
  selected.classList.remove('video-visible');
  selected.classList.add('video-hidden');
  // Un-park so the first frame can decode/render while still transparent
  selected.style.display = '';

  return { source, video: selected };
}

function releaseTransitionVideo(source: string, video: HTMLVideoElement): void {
  const bucket = transitionVideoPool.get(source);
  if (!bucket || !bucket.includes(video)) return;

  video.pause();
  video.currentTime = 0;
  video.classList.remove('video-visible');
  video.classList.add('video-hidden');
  video.style.display = 'none';
  transitionVideosInUse.delete(video);
}

/**
 * Wake a pooled portal video shortly before a scheduled scene transition so
 * its decoder is hot when the transition actually starts — the exit portal
 * plays over the live scene, so a cold start there drops frames.
 */
async function warmPooledTransitionVideo(source: string): Promise<void> {
  const bucket = transitionVideoPool.get(source) ?? [];
  const video = bucket.find((v) => !transitionVideosInUse.has(v));
  if (!video) return;

  video.style.display = '';
  try {
    await video.play();
    // First presented frame, or a timeout fallback — rVFC never fires on
    // hidden pages and the warm-up must never leave the video playing.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      if ('requestVideoFrameCallback' in video) {
        (video as any).requestVideoFrameCallback(() => {
          clearTimeout(timer);
          resolve();
        });
      }
    });
  } catch {
    // Warm-up is best-effort
  }
  // Leave it un-parked (display '') — the transition is imminent
  if (!transitionVideosInUse.has(video)) {
    video.pause();
    video.currentTime = 0;
  }
}

function listTransitionSources(scenes: Scene[]): string[] {
  const sources = new Set<string>();
  for (const scene of scenes) {
    if (scene.exitAnimation?.source) sources.add(scene.exitAnimation.source);
    if (scene.entryAnimation?.source) sources.add(scene.entryAnimation.source);
  }
  return [...sources];
}

async function preloadTransitionVideoPool(container: HTMLElement, scenes: Scene[]): Promise<void> {
  const sources = listTransitionSources(scenes);
  await Promise.all(
    sources.map(async (source) => {
      const { video } = await acquireTransitionVideo(container, source);
      releaseTransitionVideo(source, video);
    }),
  );
}

function waitMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function waitFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = Math.max(0, count);
    const step = (): void => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      remaining -= 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function init(): Promise<void> {
  // Create loading overlay
  const overlay = document.createElement('div');
  overlay.id = 'loading-overlay';
  overlay.innerHTML = `
    <div id="loading-bar-container">
      <div id="loading-bar"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const loadingBar = overlay.querySelector('#loading-bar') as HTMLElement;

  // Load configuration
  const profile = await loadProfile();
  const config = await loadAnimationConfig(profile.animationConfig);
  await applyProfileAnimations(config, profile);
  if (config.scenes.length === 0) {
    throw new Error('Animation config has no scenes');
  }

  const initialScene = config.scenes.find((scene) => scene.id === config.settings?.defaultScene)
    ?? config.scenes[0];

  // Get DOM references
  const container = document.getElementById('mascot-container')!;
  const bgVideo = document.getElementById('bg-video') as HTMLVideoElement;

  // Create engine (videos are created dynamically, one per animation)
  const engine = new AnimationEngine(initialScene, bgVideo, container);

  // Pre-fetch all videos as blobs and buffer them in memory
  await engine.preloadAll((loaded, total) => {
    loadingBar.style.width = `${(loaded / total) * 100}%`;
  });

  // Preload and warm transition overlays to avoid frame drops during scene switch
  await preloadTransitionVideoPool(container, config.scenes);

  let cleanupTouch = (): void => { };
  let cleanupRub = (): void => { };
  let cleanupRandom = (): void => { };
  let sceneTimer: ReturnType<typeof setTimeout> | null = null;
  let sceneWarmTimer: ReturnType<typeof setTimeout> | null = null;
  let sceneTransitionInProgress = false;
  let sceneRotationLocked = false;
  let nextSceneId: string | null = null;
  let nextSceneAt: number | null = null;

  const getCurrentScene = (): Scene => {
    return config.scenes.find((scene) => scene.id === engine.sceneId) ?? config.scenes[0];
  };

  const clearSceneTimer = (): void => {
    if (sceneTimer) {
      clearTimeout(sceneTimer);
      sceneTimer = null;
    }
    if (sceneWarmTimer) {
      clearTimeout(sceneWarmTimer);
      sceneWarmTimer = null;
    }
    nextSceneId = null;
    nextSceneAt = null;
  };

  const setupSceneTriggers = (scene: Scene): void => {
    cleanupTouch();
    cleanupRub();
    cleanupRandom();

    cleanupRub = setupRubTriggers(container, scene, engine);
    cleanupTouch = setupTouchTriggers(container, scene, engine);
    cleanupRandom = setupRandomTriggers(scene, engine);
  };

  const pickNextScene = (currentSceneId: string): Scene | null => {
    const candidates = config.scenes.filter((scene) => scene.id !== currentSceneId);
    if (candidates.length === 0) return null;

    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] ?? null;
  };

  const scheduleNextSceneTransition = (): void => {
    clearSceneTimer();
    if (sceneTransitionInProgress || sceneRotationLocked) return;

    const currentScene = getCurrentScene();
    const duration = getSceneDuration(currentScene);
    if (!duration || config.scenes.length < 2) return;

    const nextScene = pickNextScene(currentScene.id);
    if (!nextScene) return;

    const delay = randomInRange(duration.min, duration.max);
    nextSceneId = nextScene.id;
    nextSceneAt = Date.now() + delay;

    sceneTimer = setTimeout(() => {
      void runSceneTransition(nextScene).catch(console.warn);
    }, delay);

    // Warm the exit portal decoder shortly before the transition fires
    const exitSource = currentScene.exitAnimation?.source;
    if (exitSource) {
      sceneWarmTimer = setTimeout(() => {
        sceneWarmTimer = null;
        void warmPooledTransitionVideo(exitSource);
      }, Math.max(0, delay - 2500));
    }
  };

  const setSceneRotationLocked = (locked: boolean): void => {
    if (sceneRotationLocked === locked) return;
    sceneRotationLocked = locked;
    if (locked) {
      clearSceneTimer();
    } else {
      scheduleNextSceneTransition();
    }
  };

  const getNextSceneTransition = (): { sceneId: string; remainingMs: number } | null => {
    if (!nextSceneId || nextSceneAt === null) return null;
    return { sceneId: nextSceneId, remainingMs: Math.max(0, nextSceneAt - Date.now()) };
  };

  const waitForIdle = (): Promise<void> => {
    if (engine.isIdle) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (engine.isIdle) { resolve(); return; }
        setTimeout(check, 100);
      };
      setTimeout(check, 100);
    });
  };

  const transitionToScene = async (sceneId: string): Promise<void> => {
    if (sceneTransitionInProgress) return;
    if (sceneId === engine.sceneId) return;
    const targetScene = config.scenes.find((s) => s.id === sceneId);
    if (!targetScene) return;
    await waitForIdle();
    await runSceneTransition(targetScene);
  };

  const runSceneTransition = async (targetScene?: Scene): Promise<void> => {
    if (sceneTransitionInProgress) return;

    const currentScene = getCurrentScene();
    const nextScene = targetScene ?? pickNextScene(currentScene.id);
    if (!nextScene) return;

    sceneTransitionInProgress = true;
    clearSceneTimer();

    let exitPlayback: TransitionPlayback | null = null;
    let entryPlayback: TransitionPlayback | null = null;

    try {
      // Phase 1: pre-buffer exit video while character is still visible
      exitPlayback = await prepareTransitionVideo(container, currentScene.exitAnimation);

      if (exitPlayback) {
        // Reveal transition only when first decoded frame is available
        await exitPlayback.play();
        engine.setCharacterAndLayersVisible(false);

        await Promise.all([
          fadeBackgroundTo(engine, 0, 2000),
          exitPlayback.ended,
        ]);
      } else {
        engine.setCharacterAndLayersVisible(false);
        await fadeBackgroundTo(engine, 0, 2000);
      }

      // Phase 2: switch scene (BG playing at opacity 0, char/layers hidden)
      await engine.switchScene(nextScene, false);

      // Phase 3: pre-buffer entry video while scene is loaded but hidden
      entryPlayback = await prepareTransitionVideo(container, nextScene.entryAnimation);

      if (entryPlayback) {
        await entryPlayback.play();
        await waitFrames(1);
        exitPlayback?.cleanup();
        exitPlayback = null;

        const fadeInDelay = Math.max(0, entryPlayback.durationMs - 2000);
        await waitMs(fadeInDelay);

        await Promise.all([
          fadeBackgroundTo(engine, 1, 2000),
          entryPlayback.ended,
        ]);

        // Start character and wait until it is actually visible before removing overlay
        engine.setBackgroundOpacity(1);
        engine.start();
        await engine.waitForCurrentAnimationVisible(5000);
        await waitFrames(2);
        entryPlayback.cleanup();
        entryPlayback = null;
      } else {
        await fadeBackgroundTo(engine, 1, 2000);
        engine.setBackgroundOpacity(1);
        engine.start();
      }
    } catch (err) {
      console.warn('[scene-transition] error:', err);
      engine.setBackgroundOpacity(1);
      engine.start();
    } finally {
      exitPlayback?.cleanup();
      entryPlayback?.cleanup();
      sceneTransitionInProgress = false;
      scheduleNextSceneTransition();
    }
  };

  // Setup interaction triggers for the initial scene
  setupSceneTriggers(initialScene);

  // Rebind triggers and schedule when scene changes by any path (debug or automatic)
  engine.onSceneChange((scene) => {
    setupSceneTriggers(scene);
    scheduleNextSceneTransition();
  });

  // Start playback — all videos are already decoded and ready
  engine.start();
  engine.setBackgroundOpacity(1);
  scheduleNextSceneTransition();

  // Pause animation work while the app is in the background or the setup
  // screen is open (the editor preview needs the video decoders).
  let editorOpen = false;
  let suspended = false;
  const updateSuspended = (): void => {
    const shouldSuspend = document.hidden || editorOpen;
    if (shouldSuspend === suspended) return;
    suspended = shouldSuspend;
    if (shouldSuspend) {
      cleanupTouch();
      cleanupRub();
      cleanupRandom();
      clearSceneTimer();
      engine.pause();
    } else {
      setupSceneTriggers(getCurrentScene());
      engine.resume();
      scheduleNextSceneTransition();
    }
  };
  document.addEventListener('visibilitychange', updateSuspended);

  // Debug panel
  createDebugPanel(engine, config, transitionToScene, {
    isLocked: () => sceneRotationLocked,
    setLocked: setSceneRotationLocked,
    getNextTransition: getNextSceneTransition,
  });

  mountBadgeUi(profile, config, {
    onMotion: () => engine.triggerWhenIdle('lookaround'),
    onEditorOpenChange: (open) => {
      editorOpen = open;
      updateSuspended();
    },
  });

  // Fade out loading overlay
  overlay.classList.add('fade-out');
  setTimeout(() => overlay.remove(), 400);

  // Hide splash screen after everything is loaded and playing
  await SplashScreen.hide();

  // Warm the blob cache for every scene in the background so future scene
  // switches never fetch during the transition window.
  void prefetchAllSceneAssets(config);
}

init().catch(console.error);
