import type { Animation, AnimationConfig, Scene, TransitionSource } from './types';

export async function loadAnimationConfig(): Promise<AnimationConfig> {
  const response = await fetch('./assets/animations/animations.json');
  if (!response.ok) {
    throw new Error(`Failed to load animation config: ${response.status}`);
  }

  const config = (await response.json()) as AnimationConfig;
  return normalizeTransitionSources(config);
}

export function resolveAssetPath(source: string): string {
  return `./assets/${source.split('/').map(s => encodeURIComponent(s)).join('/')}`;
}

const blobUrlCache = new Map<string, Promise<string>>();

/**
 * Fetch a video once per app run and reuse the blob URL everywhere.
 * Scene switches and mood overrides then swap sources with zero I/O —
 * the cached URLs are never revoked (total asset set is ~17 MB).
 */
export function getCachedBlobUrl(source: string): Promise<string> {
  let cached = blobUrlCache.get(source);
  if (!cached) {
    cached = fetch(resolveAssetPath(source)).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch ${resolveAssetPath(source)}: ${response.status}`);
      }
      return URL.createObjectURL(await response.blob());
    });
    // Failed fetches must not poison the cache
    cached.catch(() => blobUrlCache.delete(source));
    blobUrlCache.set(source, cached);
  }
  return cached;
}

function collectSceneSources(scene: Scene): string[] {
  const sources = new Set<string>();
  sources.add(scene.background.source);
  if (scene.entryAnimation?.source) sources.add(scene.entryAnimation.source);
  if (scene.exitAnimation?.source) sources.add(scene.exitAnimation.source);
  for (const anim of scene.animations) sources.add(anim.source);
  for (const layer of scene.additionalLayers ?? []) sources.add(layer.source);
  for (const mood of scene.moods ?? []) {
    for (const override of mood.setAnimations ?? []) {
      if (override.source) sources.add(override.source);
    }
  }
  return [...sources];
}

/**
 * Warm the blob cache for every scene. Sequential on purpose: keeps CPU and
 * I/O pressure low while the app is already playing. Already-cached sources
 * resolve instantly, so this is safe to call at any time.
 */
export async function prefetchAllSceneAssets(config: AnimationConfig): Promise<void> {
  for (const scene of config.scenes) {
    for (const source of collectSceneSources(scene)) {
      try {
        await getCachedBlobUrl(source);
      } catch {
        // Non-fatal: the source will be fetched again on demand
      }
    }
  }
}

function normalizeTransitionSources(config: AnimationConfig): AnimationConfig {
  return {
    ...config,
    scenes: config.scenes.map(normalizeSceneTransitions),
  };
}

function normalizeSceneTransitions(scene: Scene): Scene {
  const usedIds = new Set(scene.animations.map((anim) => anim.id));
  const generatedTransitions: Animation[] = [];

  const animations = scene.animations.map((animation) => {
    const nextAnimation: Animation = { ...animation };

    nextAnimation.entryTransition = normalizeTransitionRef(
      animation.id,
      'entry',
      animation.entryTransition,
      usedIds,
      generatedTransitions,
    );

    nextAnimation.exitTransition = normalizeTransitionRef(
      animation.id,
      'exit',
      animation.exitTransition,
      usedIds,
      generatedTransitions,
    );

    return nextAnimation;
  });

  return {
    ...scene,
    animations: [...animations, ...generatedTransitions],
  };
}

function normalizeTransitionRef(
  animationId: string,
  transitionType: 'entry' | 'exit',
  transition: Animation['entryTransition'] | Animation['exitTransition'],
  usedIds: Set<string>,
  generatedTransitions: Animation[],
): string | undefined {
  if (!transition) return undefined;
  if (typeof transition === 'string') return transition;

  const transitionSource = transition as TransitionSource;
  const generatedId = createUniqueTransitionId(animationId, transitionType, usedIds);

  generatedTransitions.push({
    id: generatedId,
    source: transitionSource.source,
    loop: transitionSource.loop ?? false,
    loopCount: transitionSource.loopCount,
  });

  return generatedId;
}

function createUniqueTransitionId(
  animationId: string,
  transitionType: 'entry' | 'exit',
  usedIds: Set<string>,
): string {
  const baseId = `${animationId}__${transitionType}`;
  let candidate = baseId;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `${baseId}_${suffix}`;
    suffix++;
  }

  usedIds.add(candidate);
  return candidate;
}
