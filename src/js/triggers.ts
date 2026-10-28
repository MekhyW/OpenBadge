import type { Scene, Animation, AdditionalLayer, InteractionTrigger, TouchRegion } from './types';
import { AnimationEngine } from './animation-engine';

let _rubActive = false;
let _pointerDown = false;

// Collect rub regions so touch triggers can tell if a tap is in a rub zone
const _rubRegions: TouchRegion[] = [];

export function setupRubTriggers(
  container: HTMLElement,
  scene: Scene,
  engine: AnimationEngine,
): () => void {
  _rubRegions.length = 0;
  _rubActive = false;
  _pointerDown = false;

  const rubAnimations: { animation: Animation; trigger: InteractionTrigger }[] = [];

  for (const anim of scene.animations) {
    if (!anim.interactionTriggers) continue;
    for (const trigger of anim.interactionTriggers) {
      if (trigger.type === 'rub' && trigger.region) {
        rubAnimations.push({ animation: anim, trigger });
        _rubRegions.push(trigger.region);
      }
    }
  }

  if (rubAnimations.length === 0) return () => { };

  let activeRubAnim: Animation | null = null;
  let activeRubTrigger: InteractionTrigger | null = null;
  let startX = 0;
  let startY = 0;
  let totalMovement = 0;
  const RUB_THRESHOLD = 8;

  // The container is fixed fullscreen — cache its rect instead of forcing a
  // layout read on the touch frame; invalidate on resize/rotation.
  let cachedRect: DOMRect | null = null;
  const getRect = (): DOMRect => {
    if (!cachedRect) cachedRect = container.getBoundingClientRect();
    return cachedRect;
  };
  const invalidateRect = (): void => { cachedRect = null; };
  window.addEventListener('resize', invalidateRect);

  const removeRubLoopListener = engine.onRubLoop((animationId) => {
    if (!activeRubAnim || !activeRubTrigger) return;
    if (activeRubAnim.id !== animationId) return;
  });

  const isInRegion = (clientX: number, clientY: number, region: TouchRegion): boolean => {
    const rect = getRect();
    const normX = (clientX - rect.left) / rect.width;
    const normY = (clientY - rect.top) / rect.height;
    return normX >= region.x && normX <= region.x + region.width &&
      normY >= region.y && normY <= region.y + region.height;
  };

  const startRub = (anim: Animation, trigger: InteractionTrigger): void => {
    if (activeRubAnim) return;
    activeRubAnim = anim;
    activeRubTrigger = trigger;
    _rubActive = true;
    if (trigger.loopWhileActive) {
      engine.startRubAnimation(anim.id);
    } else {
      engine.interruptWith(anim.id);
    }
  };

  const stopRub = (): void => {
    if (!activeRubAnim) return;
    activeRubAnim = null;
    activeRubTrigger = null;
    _rubActive = false;
    engine.stopRubAnimation();
  };

  const onPointerDown = (e: PointerEvent): void => {
    _pointerDown = true;
    startX = e.clientX;
    startY = e.clientY;
    totalMovement = 0;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!_pointerDown) return;

    totalMovement += Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY);
    startX = e.clientX;
    startY = e.clientY;

    if (activeRubAnim) {
      // Check if pointer left the active region
      const activeTrigger = rubAnimations.find(r => r.animation === activeRubAnim)?.trigger;
      if (activeTrigger && !isInRegion(e.clientX, e.clientY, activeTrigger.region!)) {
        stopRub();
      }
      return;
    }

    // Check if movement threshold reached inside a rub region
    if (totalMovement >= RUB_THRESHOLD) {
      for (const { animation, trigger } of rubAnimations) {
        if (isInRegion(e.clientX, e.clientY, trigger.region!)) {
          startRub(animation, trigger);
          break;
        }
      }
    }
  };

  const onPointerUpOrCancel = (): void => {
    _pointerDown = false;
    totalMovement = 0;
    stopRub();
  };

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUpOrCancel);
  container.addEventListener('pointercancel', onPointerUpOrCancel);

  return () => {
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerup', onPointerUpOrCancel);
    container.removeEventListener('pointercancel', onPointerUpOrCancel);
    window.removeEventListener('resize', invalidateRect);
    removeRubLoopListener();
    _pointerDown = false;
    _rubActive = false;
    _rubRegions.length = 0;
    cachedRect = null;
    stopRub();
  };
}

export function setupTouchTriggers(
  container: HTMLElement,
  scene: Scene,
  engine: AnimationEngine,
): () => void {
  const touchAnimations: { animation: Animation; trigger: InteractionTrigger }[] = [];

  for (const anim of scene.animations) {
    if (!anim.interactionTriggers) continue;
    for (const trigger of anim.interactionTriggers) {
      if (trigger.type === 'touch' && trigger.region) {
        touchAnimations.push({ animation: anim, trigger });
      }
    }
  }

  // Also register touch triggers from additional layers
  for (const layer of scene.additionalLayers ?? []) {
    if (!layer.interactionTriggers || !layer.targetAnimation) continue;
    const targetAnim = scene.animations.find(a => a.id === layer.targetAnimation);
    if (!targetAnim) continue;
    for (const trigger of layer.interactionTriggers) {
      if (trigger.type === 'touch' && trigger.region) {
        touchAnimations.push({ animation: targetAnim, trigger });
      }
    }
  }

  if (touchAnimations.length === 0) return () => { };

  // Cache the fixed fullscreen container rect — avoids forced layout reads
  // on the touch frame; invalidated on resize/rotation.
  let cachedRect: DOMRect | null = null;
  const getRect = (): DOMRect => {
    if (!cachedRect) cachedRect = container.getBoundingClientRect();
    return cachedRect;
  };
  const invalidateRect = (): void => { cachedRect = null; };
  window.addEventListener('resize', invalidateRect);

  const isInRubRegion = (normX: number, normY: number): boolean => {
    for (const r of _rubRegions) {
      if (normX >= r.x && normX <= r.x + r.width &&
        normY >= r.y && normY <= r.y + r.height) {
        return true;
      }
    }
    return false;
  };

  const handleInteraction = (clientX: number, clientY: number): void => {
    if (_rubActive) return;

    const rect = getRect();
    const normX = (clientX - rect.left) / rect.width;
    const normY = (clientY - rect.top) / rect.height;

    for (const { animation, trigger } of touchAnimations) {
      const r = trigger.region!;
      if (
        normX >= r.x &&
        normX <= r.x + r.width &&
        normY >= r.y &&
        normY <= r.y + r.height
      ) {
        if (trigger.waitForCompletion) {
          engine.triggerWhenIdle(animation.id);
        } else {
          engine.interruptWith(animation.id);
        }
        break;
      }
    }
  };

  // For touches in rub regions, defer to pointerup so rub has priority
  // For other regions, fire immediately on touchstart
  const onTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = getRect();
    const normX = (touch.clientX - rect.left) / rect.width;
    const normY = (touch.clientY - rect.top) / rect.height;

    if (!isInRubRegion(normX, normY)) {
      handleInteraction(touch.clientX, touch.clientY);
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (_rubActive) return;
    const rect = getRect();
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top) / rect.height;

    if (isInRubRegion(normX, normY)) {
      handleInteraction(e.clientX, e.clientY);
    }
  };

  const onClick = (e: MouseEvent): void => {
    handleInteraction(e.clientX, e.clientY);
  };

  // For touches in rub regions, defer to pointerup so rub has priority
  // For other regions, fire immediately on touchstart
  container.addEventListener('touchstart', onTouchStart, { passive: false });

  // Handle taps in rub regions — only fire if no rub was activated
  container.addEventListener('pointerup', onPointerUp);

  container.addEventListener('click', onClick);

  return () => {
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('pointerup', onPointerUp);
    container.removeEventListener('click', onClick);
    window.removeEventListener('resize', invalidateRect);
  };
}

export function setupRandomTriggers(
  scene: Scene,
  engine: AnimationEngine,
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];

  const registerRandomTriggers = (animId: string, triggers: InteractionTrigger[]): void => {
    for (const trigger of triggers) {
      if (trigger.type === 'random' && trigger.timeRange) {
        const { min, max } = trigger.timeRange;
        const waitForCompletion = trigger.waitForCompletion;

        const scheduleNext = (): void => {
          const delay = min + Math.random() * (max - min);
          const timer = setTimeout(() => {
            const idx = timers.indexOf(timer);
            if (idx >= 0) timers.splice(idx, 1);
            if (waitForCompletion) {
              engine.triggerWhenIdle(animId);
            } else {
              engine.triggerAnimation(animId);
            }
            scheduleNext();
          }, delay);
          timers.push(timer);
        };

        scheduleNext();
      }
    }
  };

  for (const anim of scene.animations) {
    if (!anim.interactionTriggers) continue;
    registerRandomTriggers(anim.id, anim.interactionTriggers);
  }

  // Also register random triggers from additional layers
  for (const layer of scene.additionalLayers ?? []) {
    if (!layer.interactionTriggers || !layer.targetAnimation) continue;
    registerRandomTriggers(layer.targetAnimation, layer.interactionTriggers);
  }

  return () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.length = 0;
  };
}
