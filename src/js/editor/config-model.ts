import type { Animation, AnimationConfig, Scene, TransitionSource } from '../types';

/** Ids the config loader generates when it turns inline transitions into animations. */
const GENERATED_TRANSITION_ID = /__(entry|exit)(_\d+)?$/;

/** Remove keys whose value is undefined so saved configs stay tidy. */
function dropUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

/**
 * Turn the runtime (normalized) config back into the authoring shape the
 * editor works with: transitions that the loader turned into hidden
 * `<id>__entry` animations go back to being inline videos on their parent.
 */
export function toEditableConfig(config: AnimationConfig): AnimationConfig {
  const draft = repairConfig(structuredClone(config));
  draft.settings = dropUndefined({ ...(draft.settings ?? {}) });
  draft.scenes = draft.scenes.map(inlineGeneratedTransitions);
  return draft;
}

// ── Repair ──
// Saved or imported configs can miss required fields (the old editor let you
// delete any property). Fill them with empty values so the editor can open,
// and let validation tell the user what to fix.

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const asNumber = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const objects = (value: unknown): Loose[] => Array.isArray(value) ? value.filter(isObject) : [];

function repairTriggers(owner: Loose): void {
  if (owner.interactionTriggers === undefined) return;
  const triggers = objects(owner.interactionTriggers).filter((trigger) => ['touch', 'rub', 'random'].includes(trigger.type as string));
  for (const trigger of triggers) {
    trigger.waitForCompletion = Boolean(trigger.waitForCompletion);
    if (trigger.region !== undefined) {
      const region = isObject(trigger.region) ? trigger.region : {};
      trigger.region = {
        x: asNumber(region.x, 0), y: asNumber(region.y, 0),
        width: asNumber(region.width, 0), height: asNumber(region.height, 0),
      };
    }
    if (trigger.timeRange !== undefined) {
      const range = isObject(trigger.timeRange) ? trigger.timeRange : {};
      trigger.timeRange = { min: asNumber(range.min, 10000), max: asNumber(range.max, 20000) };
    }
  }
  owner.interactionTriggers = triggers;
}

function repairTransition(value: unknown): unknown {
  if (typeof value === 'string' || value === undefined) return value;
  if (!isObject(value)) return undefined;
  return { ...value, source: asString(value.source), loop: Boolean(value.loop) };
}

function repairScene(scene: Loose): Scene {
  scene.id = asString(scene.id);
  const background = isObject(scene.background) ? scene.background : {};
  scene.background = { ...background, source: asString(background.source), loop: background.loop !== false };
  for (const key of ['entryAnimation', 'exitAnimation'] as const) {
    if (scene[key] === undefined) continue;
    if (isObject(scene[key])) scene[key] = repairTransition(scene[key]);
    else delete scene[key];
  }

  const animations = objects(scene.animations);
  for (const animation of animations) {
    animation.id = asString(animation.id);
    animation.source = asString(animation.source);
    animation.loop = Boolean(animation.loop);
    animation.entryTransition = repairTransition(animation.entryTransition);
    animation.exitTransition = repairTransition(animation.exitTransition);
    if (animation.setsMood !== undefined) animation.setsMood = asString(animation.setsMood) || undefined;
    repairTriggers(animation);
    dropUndefined(animation);
  }
  scene.animations = animations;
  scene.defaultAnimation = asString(scene.defaultAnimation);
  if (scene.defaultMood !== undefined) scene.defaultMood = asString(scene.defaultMood) || undefined;

  if (scene.additionalLayers !== undefined) {
    const layers = objects(scene.additionalLayers);
    for (const layer of layers) {
      if (layer.id !== undefined) layer.id = asString(layer.id) || undefined;
      layer.source = asString(layer.source);
      layer.loop = layer.loop !== false;
      layer.layerOrder = asNumber(layer.layerOrder, 1);
      layer.layerPriority = layer.layerPriority === 'background' ? 'background' : 'foreground';
      repairTriggers(layer);
      dropUndefined(layer);
    }
    scene.additionalLayers = layers;
  }

  if (scene.moods !== undefined) {
    const moods = objects(scene.moods);
    for (const mood of moods) {
      mood.id = asString(mood.id);
      if (mood.setAnimations !== undefined) {
        mood.setAnimations = objects(mood.setAnimations).map((effect) => ({ ...effect, animation: asString(effect.animation) }));
      }
      repairTriggers(mood);
    }
    scene.moods = moods;
  }

  if (scene.sceneDuration !== undefined) {
    const duration = isObject(scene.sceneDuration) ? scene.sceneDuration : {};
    scene.sceneDuration = { min: asNumber(duration.min, 90000), max: asNumber(duration.max, 150000) };
  }
  return dropUndefined(scene) as unknown as Scene;
}

function repairConfig(config: unknown): AnimationConfig {
  const root: Loose = isObject(config) ? config : {};
  const settings = isObject(root.settings) ? root.settings : {};
  if (settings.defaultScene !== undefined) settings.defaultScene = asString(settings.defaultScene) || undefined;
  return {
    ...root,
    settings: dropUndefined(settings),
    scenes: objects(root.scenes).map(repairScene),
  } as AnimationConfig;
}

function inlineGeneratedTransitions(scene: Scene): Scene {
  const references = new Map<string, number>();
  const count = (id?: string): void => { if (id) references.set(id, (references.get(id) ?? 0) + 1); };
  count(scene.defaultAnimation);
  for (const animation of scene.animations) {
    if (typeof animation.entryTransition === 'string') count(animation.entryTransition);
    if (typeof animation.exitTransition === 'string') count(animation.exitTransition);
  }
  for (const mood of scene.moods ?? []) for (const effect of mood.setAnimations ?? []) count(effect.animation);
  for (const layer of scene.additionalLayers ?? []) count(layer.targetAnimation);

  const byId = new Map(scene.animations.map((animation) => [animation.id, animation]));
  const inlined = new Set<string>();
  const inline = (ref: Animation['entryTransition']): Animation['entryTransition'] => {
    if (typeof ref !== 'string') return ref;
    const target = byId.get(ref);
    if (!target || !GENERATED_TRANSITION_ID.test(ref) || references.get(ref) !== 1) return ref;
    if (target.interactionTriggers?.length) return ref;
    inlined.add(ref);
    return dropUndefined<TransitionSource>({ source: target.source, loop: target.loop, loopCount: target.loopCount });
  };

  for (const animation of scene.animations) {
    animation.entryTransition = inline(animation.entryTransition);
    animation.exitTransition = inline(animation.exitTransition);
    dropUndefined(animation);
  }
  scene.animations = scene.animations.filter((animation) => !inlined.has(animation.id));
  return scene;
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const clean = base.trim().toLowerCase().replace(/\s+/g, '-') || 'item';
  if (!used.has(clean)) return clean;
  let suffix = 2;
  while (used.has(`${clean}-${suffix}`)) suffix++;
  return `${clean}-${suffix}`;
}

/** "lookaround" → "Lookaround", "new-layer" → "New layer". */
export function displayName(id: string | undefined): string {
  const spaced = (id ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Untitled';
}

/** A short, human-readable name for a video source. */
export function describeSource(source: string | undefined, mediaNames: Record<string, string>): string {
  if (!source) return 'No video';
  if (source.startsWith('local:')) return mediaNames[source] ?? 'Uploaded video';
  const file = source.split('/').pop() ?? source;
  return file.replace(/\.[a-z0-9]+$/i, '');
}

// ── Renames keep every reference in the scene pointing at the right thing ──

export function renameAnimation(scene: Scene, from: string, to: string): void {
  if (from === to) return;
  if (scene.defaultAnimation === from) scene.defaultAnimation = to;
  for (const animation of scene.animations) {
    if (animation.id === from) animation.id = to;
    if (animation.entryTransition === from) animation.entryTransition = to;
    if (animation.exitTransition === from) animation.exitTransition = to;
  }
  for (const mood of scene.moods ?? []) for (const effect of mood.setAnimations ?? []) {
    if (effect.animation === from) effect.animation = to;
  }
  for (const layer of scene.additionalLayers ?? []) if (layer.targetAnimation === from) layer.targetAnimation = to;
}

export function renameMood(scene: Scene, from: string, to: string): void {
  if (from === to) return;
  if (scene.defaultMood === from) scene.defaultMood = to;
  for (const mood of scene.moods ?? []) if (mood.id === from) mood.id = to;
  for (const animation of scene.animations) if (animation.setsMood === from) animation.setsMood = to;
}

export function renameLayer(scene: Scene, from: string, to: string): void {
  if (from === to) return;
  for (const layer of scene.additionalLayers ?? []) if (layer.id === from) layer.id = to;
  for (const mood of scene.moods ?? []) for (const effect of mood.setAnimations ?? []) {
    if (effect.animation === from) effect.animation = to;
  }
}

/** Remove an animation and every reference to it. */
export function deleteAnimation(scene: Scene, id: string): void {
  scene.animations = scene.animations.filter((animation) => animation.id !== id);
  for (const animation of scene.animations) {
    if (animation.entryTransition === id) delete animation.entryTransition;
    if (animation.exitTransition === id) delete animation.exitTransition;
  }
  for (const mood of scene.moods ?? []) {
    mood.setAnimations = (mood.setAnimations ?? []).filter((effect) => effect.animation !== id);
  }
  for (const layer of scene.additionalLayers ?? []) if (layer.targetAnimation === id) delete layer.targetAnimation;
}

export function deleteMood(scene: Scene, id: string): void {
  scene.moods = (scene.moods ?? []).filter((mood) => mood.id !== id);
  if (scene.defaultMood === id) delete scene.defaultMood;
  for (const animation of scene.animations) if (animation.setsMood === id) delete animation.setsMood;
}

export function deleteLayer(scene: Scene, index: number): void {
  const [removed] = (scene.additionalLayers ?? []).splice(index, 1);
  if (!removed?.id) return;
  for (const mood of scene.moods ?? []) {
    mood.setAnimations = (mood.setAnimations ?? []).filter((effect) => effect.animation !== removed.id);
  }
}

export function createBlankScene(config: AnimationConfig): Scene {
  return {
    id: uniqueId('new-scene', config.scenes.map((scene) => scene.id)),
    background: { source: '', loop: true },
    sceneDuration: { min: 90000, max: 150000 },
    defaultAnimation: 'idle',
    animations: [{ id: 'idle', source: '', loop: true }],
  };
}

// ── Validation ──

export interface ConfigIssue {
  sceneId?: string;
  message: string;
}

export function validateConfig(config: AnimationConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (!config.scenes.length) issues.push({ message: 'Add at least one scene.' });

  const sceneIds = new Set<string>();
  for (const scene of config.scenes) {
    const name = displayName(scene.id || 'Untitled scene');
    const add = (message: string): void => { issues.push({ sceneId: scene.id, message: `${name}: ${message}` }); };

    if (!scene.id.trim()) add('the scene needs a name.');
    else if (sceneIds.has(scene.id)) add('another scene already uses this name.');
    sceneIds.add(scene.id);

    if (!scene.background?.source) add('choose a background video.');
    if (!scene.animations.length) add('add at least one animation.');

    const animationIds = new Set<string>();
    for (const animation of scene.animations) {
      if (!animation.id.trim()) add('an animation needs a name.');
      else if (animationIds.has(animation.id)) add(`two animations are named "${animation.id}".`);
      animationIds.add(animation.id);
      if (!animation.source) add(`choose a video for "${displayName(animation.id)}".`);
      for (const trigger of animation.interactionTriggers ?? []) {
        if ((trigger.type === 'touch' || trigger.type === 'rub') && !(trigger.region && trigger.region.width > 0 && trigger.region.height > 0)) {
          add(`draw a touch area for "${displayName(animation.id)}".`);
        }
      }
    }
    if (!animationIds.has(scene.defaultAnimation)) add('choose a starting animation.');

    const moodIds = new Set((scene.moods ?? []).map((mood) => mood.id));
    if (scene.defaultMood && !moodIds.has(scene.defaultMood)) add('the starting mood no longer exists.');
    if (moodIds.size !== (scene.moods ?? []).length) add('two moods share the same name.');

    for (const layer of scene.additionalLayers ?? []) {
      if (!layer.source) add(`choose a video for layer "${displayName(layer.id ?? 'layer')}".`);
    }

    const duration = scene.sceneDuration;
    if (duration && (duration.min <= 0 || duration.max < duration.min)) {
      add('the time on screen must be positive, with the shortest time first.');
    }
  }

  if (config.settings?.defaultScene && !sceneIds.has(config.settings.defaultScene)) {
    issues.push({ message: 'The starting scene no longer exists. Choose another one in Settings.' });
  }
  return issues;
}
