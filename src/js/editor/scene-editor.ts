import type {
  AdditionalLayer, Animation, AnimationConfig, InteractionTrigger, Mood, Scene, TouchRegion, TransitionSource,
} from '../types';
import {
  deleteAnimation, deleteLayer, deleteMood, describeSource, displayName, renameAnimation, renameLayer, renameMood, uniqueId,
} from './config-model';
import { h, icon } from './dom';
import {
  button, emptyState, field, itemCard, numberInput, secondsInput, secondsRange, sectionHeader, segmented, select,
  textInput, toggle, videoPicker, type Option,
} from './fields';
import { SceneStage, type StageRegion } from './stage';

export interface EditorContext {
  config: AnimationConfig;
  mediaNames: Record<string, string>;
  upload: (file: File) => Promise<string>;
  markDirty: () => void;
}

export interface SceneEditorHandle {
  element: HTMLElement;
  destroy: () => void;
}

type Tab = 'general' | 'animations' | 'layers' | 'moods';
type TriggerKind = InteractionTrigger['type'];

const TRIGGER_LABELS: Record<TriggerKind, string> = {
  touch: 'Tap',
  rub: 'Rub / pet',
  random: 'At random times',
};

const SIZE_PRESETS: Record<string, { width: string; height: string } | null> = {
  fill: { width: '100%', height: '100%' },
  width: { width: '100%', height: 'auto' },
  height: { width: 'auto', height: '100%' },
  natural: { width: 'auto', height: 'auto' },
  custom: null,
};

function sizePreset(layer: AdditionalLayer): string {
  const size = layer.size ?? { width: '100%', height: '100%' };
  for (const [key, preset] of Object.entries(SIZE_PRESETS)) {
    if (preset && preset.width === size.width && preset.height === size.height) return key;
  }
  return 'custom';
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function describeRegion(region: TouchRegion | undefined): string {
  if (!region || region.width <= 0 || region.height <= 0) return 'No area drawn yet';
  return `${percent(region.width)} × ${percent(region.height)} area, ${percent(region.x)} from left, ${percent(region.y)} from top`;
}

function describePlayback(animation: Animation): string {
  if (animation.loopCount) return `Plays ${animation.loopCount}×`;
  return animation.loop ? 'Loops' : 'Plays once';
}

export function createSceneEditor(
  context: EditorContext,
  scene: Scene,
  actions: { onBack: () => void; onDuplicate: () => void; onDelete: () => void; onRenamed: () => void },
): SceneEditorHandle {
  const { config } = context;
  const stage = new SceneStage();
  const describe = (source: string | undefined): string => describeSource(source, context.mediaNames);

  let tab: Tab = 'general';
  const openKeys = new Set<string>();
  let selectedKey = '';
  let regionsVisible = false;
  let activeRegionKey = '';

  const title = h('h2', { class: 'se-title' });
  const tabBar = h('nav', { class: 'ed-tabs se-tabs', role: 'tablist' });
  const tabContent = h('div', { class: 'se-tab-content' });
  const nowPlaying = h('span', { class: 'se-now-playing' });
  const quickPicks = h('div', { class: 'se-quick', role: 'group', 'aria-label': 'Preview an animation' });

  const changed = (): void => context.markDirty();

  // ── Preview ──

  const play = (key: string, label: string, source: string | undefined, onTop = false): void => {
    selectedKey = key;
    nowPlaying.replaceChildren('Previewing ', h('strong', null, label));
    void stage.playCharacter(source, onTop);
    for (const chip of quickPicks.querySelectorAll<HTMLElement>('button')) {
      chip.setAttribute('aria-pressed', String(chip.dataset.key === key));
    }
    for (const card of tabContent.querySelectorAll<HTMLElement>('.ed-item')) {
      card.classList.toggle('is-selected', card.dataset.key === key);
    }
  };

  const playAnimation = (animation: Animation): void => {
    play(`animation:${animation.id}`, displayName(animation.id), animation.source);
  };

  const transitionSource = (ref: Animation['entryTransition']): string | undefined => {
    if (!ref) return undefined;
    if (typeof ref === 'string') return scene.animations.find((animation) => animation.id === ref)?.source;
    return ref.source;
  };

  const renderQuickPicks = (): void => {
    const chips: HTMLElement[] = scene.animations.map((animation) => {
      const chip = h('button', { type: 'button', class: 'ed-chip-button', dataset: { key: `animation:${animation.id}` } }, displayName(animation.id));
      chip.addEventListener('click', () => playAnimation(animation));
      return chip;
    });
    const portal = (key: string, label: string, transition: TransitionSource | undefined): void => {
      if (!transition?.source) return;
      const chip = h('button', { type: 'button', class: 'ed-chip-button is-portal', dataset: { key } }, label);
      chip.addEventListener('click', () => play(key, label, transition.source, true));
      chips.push(chip);
    };
    portal('portal:entry', 'Arrival', scene.entryAnimation);
    portal('portal:exit', 'Departure', scene.exitAnimation);
    quickPicks.replaceChildren(...chips);
    for (const chip of chips) chip.setAttribute('aria-pressed', String(chip.dataset.key === selectedKey));
  };

  const collectRegions = (): StageRegion[] => {
    const regions: StageRegion[] = [];
    scene.animations.forEach((animation, animationIndex) => {
      (animation.interactionTriggers ?? []).forEach((trigger, triggerIndex) => {
        if (!trigger.region || trigger.type === 'random') return;
        const key = `animation:${animationIndex}:${triggerIndex}`;
        regions.push({ key, label: `${displayName(animation.id)} · ${TRIGGER_LABELS[trigger.type].toLowerCase()}`, region: trigger.region, active: key === activeRegionKey });
      });
    });
    (scene.additionalLayers ?? []).forEach((layer, layerIndex) => {
      (layer.interactionTriggers ?? []).forEach((trigger, triggerIndex) => {
        if (!trigger.region || trigger.type === 'random') return;
        const key = `layer:${layerIndex}:${triggerIndex}`;
        regions.push({ key, label: `${displayName(layer.id ?? 'layer')} · tap`, region: trigger.region, active: key === activeRegionKey });
      });
    });
    return regions;
  };

  const updateRegions = (): void => stage.setRegions(collectRegions(), regionsVisible);

  const playToggle = button('Pause', () => {
    stage.setPlaying(!stage.isPlaying);
    playToggle.replaceChildren(icon(stage.isPlaying ? 'pause' : 'play'), h('span', null, stage.isPlaying ? 'Pause' : 'Play'));
  }, { icon: 'pause', small: true });
  const layersToggle = toggle('Layers', true, (visible) => stage.setLayersVisible(visible));
  const regionsToggle = toggle('Touch areas', false, (visible) => { regionsVisible = visible; updateRegions(); });

  const previewPane = h('aside', { class: 'se-preview', 'aria-label': 'Scene preview' },
    h('div', { class: 'se-stage-wrap' }, stage.element),
    h('div', { class: 'se-controls' }, playToggle, layersToggle, regionsToggle),
    nowPlaying,
    quickPicks,
  );

  // ── Shared editors ──

  /** A name field that refuses empty or duplicate names. */
  const nameInput = (current: string, taken: () => string[], apply: (next: string) => void, required = true): HTMLElement => {
    const message = h('p', { class: 'ed-error', role: 'alert' });
    const input = textInput(current, () => undefined, { commitOnBlur: true, maxLength: 48 });
    input.addEventListener('change', () => {
      const next = input.value.trim();
      message.textContent = '';
      input.removeAttribute('aria-invalid');
      if (!next && required) { message.textContent = 'A name is required.'; input.setAttribute('aria-invalid', 'true'); return; }
      if (next !== current && taken().includes(next)) { message.textContent = `"${next}" is already used in this scene.`; input.setAttribute('aria-invalid', 'true'); return; }
      apply(next);
      current = next;
      changed();
    });
    return h('div', null, input, message);
  };

  const animationOptions = (exclude?: string): Option[] => scene.animations
    .filter((animation) => animation.id !== exclude)
    .map((animation) => ({ value: animation.id, label: displayName(animation.id) }));

  const moodOptions = (noneLabel: string): Option[] => [
    { value: '', label: noneLabel },
    ...(scene.moods ?? []).map((mood) => ({ value: mood.id, label: displayName(mood.id) })),
  ];

  const regionEditor = (trigger: InteractionTrigger, key: string): HTMLElement => {
    const text = h('span', { class: 'ed-region-text' }, describeRegion(trigger.region));
    const drawButton = button('Draw on preview', async () => {
      activeRegionKey = key;
      updateRegions();
      drawButton.disabled = true;
      cancel.hidden = false;
      // Enlarge the preview and show instructions while drawing.
      const previous = [...nowPlaying.childNodes];
      nowPlaying.replaceChildren('Drag on the preview to draw the touch area. ',
        button('Cancel', () => stage.cancelDrawing(), { small: true, variant: 'ghost' }));
      previewPane.classList.add('is-drawing');
      previewPane.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const region = await stage.drawRegion();
      previewPane.classList.remove('is-drawing');
      nowPlaying.replaceChildren(...previous);
      drawButton.disabled = false;
      cancel.hidden = true;
      if (region) {
        trigger.region = region;
        text.textContent = describeRegion(region);
        changed();
      }
      updateRegions();
    }, { icon: 'target', small: true });
    const cancel = button('Cancel', () => stage.cancelDrawing(), { small: true, variant: 'ghost' });
    cancel.hidden = true;
    const show = button('', () => { activeRegionKey = activeRegionKey === key ? '' : key; updateRegions(); }, { icon: 'eye', small: true, title: 'Highlight this area on the preview' });
    return h('div', { class: 'ed-region' }, text, h('div', { class: 'ed-inline-actions' }, show, drawButton, cancel));
  };

  const defaultRegion = (): TouchRegion => ({ x: 0.3, y: 0.3, width: 0.4, height: 0.2 });

  const triggerList = (
    owner: { interactionTriggers?: InteractionTrigger[] },
    kinds: TriggerKind[],
    keyPrefix: string,
    options: { mood?: boolean; emptyText: string },
  ): HTMLElement => {
    const root = h('div', { class: 'ed-triggers' });
    const render = (): void => {
      const triggers = owner.interactionTriggers ?? [];
      const rows = triggers.map((trigger, index) => {
        const key = `${keyPrefix}:${index}`;
        const body = h('div', { class: 'ed-trigger-body' });
        const renderBody = (): void => {
          body.replaceChildren();
          if (trigger.type === 'touch' || trigger.type === 'rub') {
            trigger.region ??= defaultRegion();
            body.append(field('Touch area', regionEditor(trigger, key)));
          }
          if (trigger.type === 'rub') {
            body.append(toggle('Keep playing while rubbing', Boolean(trigger.loopWhileActive), (value) => {
              if (value) trigger.loopWhileActive = true; else delete trigger.loopWhileActive;
              changed();
            }));
          }
          if (trigger.type === 'random') {
            trigger.timeRange ??= { min: 10000, max: 20000 };
            body.append(field('Every', secondsRange(trigger.timeRange, changed), 'A random wait between these two times.'));
            if (options.mood) {
              trigger.duration ??= 10000;
              body.append(field('Mood lasts', secondsInput(trigger.duration, (value) => { trigger.duration = value; changed(); })));
            }
          }
          if (!options.mood) {
            body.append(toggle('Wait for the current animation to finish', trigger.waitForCompletion, (value) => { trigger.waitForCompletion = value; changed(); },
              'Off: interrupts whatever is playing.'));
          }
        };
        renderBody();
        const typeSelect = kinds.length > 1
          ? select(kinds.map((kind) => ({ value: kind, label: TRIGGER_LABELS[kind] })), trigger.type, (kind) => {
            trigger.type = kind;
            if (kind === 'random') delete trigger.region;
            else delete trigger.timeRange;
            if (kind !== 'rub') delete trigger.loopWhileActive;
            renderBody();
            updateRegions();
            changed();
          })
          : h('strong', null, TRIGGER_LABELS[trigger.type]);
        const remove = button('', () => {
          triggers.splice(index, 1);
          if (!triggers.length) delete owner.interactionTriggers;
          render();
          updateRegions();
          changed();
        }, { icon: 'trash', title: 'Remove trigger', small: true, variant: 'ghost' });
        return h('div', { class: 'ed-trigger' },
          h('div', { class: 'ed-trigger-head' }, h('span', { class: 'ed-trigger-when' }, 'When'), typeSelect, remove),
          body,
        );
      });
      const add = button('Add trigger', () => {
        const kind = kinds[0];
        const trigger: InteractionTrigger = { type: kind, waitForCompletion: kind === 'random' };
        if (kind === 'random') trigger.timeRange = { min: 10000, max: 20000 };
        else trigger.region = defaultRegion();
        if (options.mood) trigger.duration = 10000;
        (owner.interactionTriggers ??= []).push(trigger);
        render();
        updateRegions();
        changed();
      }, { icon: 'plus', small: true });
      root.replaceChildren(...(rows.length ? rows : [emptyState(options.emptyText)]), add);
    };
    render();
    return root;
  };

  const transitionField = (animation: Animation, key: 'entryTransition' | 'exitTransition', label: string): HTMLElement => {
    const container = h('div', { class: 'ed-stack' });
    const mode = (): 'none' | 'video' | 'animation' => {
      const value = animation[key];
      if (!value) return 'none';
      return typeof value === 'string' ? 'animation' : 'video';
    };
    const render = (): void => {
      const current = mode();
      const modeSelect = select<'none' | 'video' | 'animation'>([
        { value: 'none', label: 'None' },
        { value: 'video', label: 'Play a video' },
        { value: 'animation', label: 'Play another animation' },
      ], current, (next) => {
        if (next === 'none') delete animation[key];
        else if (next === 'video') animation[key] = { source: '', loop: false };
        else animation[key] = animationOptions(animation.id)[0]?.value ?? '';
        render();
        changed();
      });
      const parts: HTMLElement[] = [modeSelect];
      const value = animation[key];
      if (value && typeof value === 'object') {
        parts.push(videoPicker({
          source: value.source || undefined,
          label,
          describe,
          upload: context.upload,
          onChange: (source) => { value.source = source ?? ''; changed(); },
          onPreview: () => play(`${key}:${animation.id}`, `${displayName(animation.id)} · ${label.toLowerCase()}`, value.source),
        }));
      } else if (typeof value === 'string') {
        parts.push(select(animationOptions(animation.id), value, (next) => { animation[key] = next; changed(); }));
      }
      container.replaceChildren(...parts);
    };
    render();
    return field(label, container);
  };

  const card = (key: string, title: string, meta: (string | HTMLElement)[], body: () => HTMLElement[], onSelect?: () => void): HTMLElement => itemCard({
    key,
    title,
    meta,
    open: openKeys.has(key),
    selected: key === selectedKey,
    onToggle: (open) => { if (open) openKeys.add(key); else openKeys.delete(key); },
    onSelect,
    body,
  });

  // ── Tabs ──

  const renderGeneral = (): HTMLElement[] => {
    const isStartScene = (config.settings?.defaultScene ?? config.scenes[0]?.id) === scene.id;
    const rotation = scene.sceneDuration;
    const rotationRange = h('div');
    const renderRotation = (): void => {
      rotationRange.replaceChildren(scene.sceneDuration
        ? field('Stay on screen for', secondsRange(scene.sceneDuration, changed), 'The badge picks a random time in this range, then moves to another scene.')
        : h('p', { class: 'ed-hint' }, 'This scene stays until another scene is chosen.'));
    };
    renderRotation();
    const portalPicker = (key: 'entryAnimation' | 'exitAnimation', label: string, hint: string): HTMLElement => field(label, videoPicker({
      source: scene[key]?.source,
      label,
      describe,
      upload: context.upload,
      optional: true,
      onChange: (source) => {
        if (source) scene[key] = { ...(scene[key] ?? { loop: false }), source };
        else delete scene[key];
        renderQuickPicks();
        changed();
      },
      onPreview: () => play(key === 'entryAnimation' ? 'portal:entry' : 'portal:exit', label, scene[key]?.source, true),
    }), hint);

    return [
      h('section', { class: 'ed-section' },
        sectionHeader('Scene'),
        field('Name', nameInput(scene.id, () => config.scenes.filter((other) => other !== scene).map((other) => other.id), (next) => {
          if (config.settings?.defaultScene === scene.id) config.settings.defaultScene = next;
          scene.id = next;
          title.textContent = displayName(next);
          actions.onRenamed();
        })),
        field('Background video', videoPicker({
          source: scene.background?.source,
          label: 'Background',
          describe,
          upload: context.upload,
          onChange: (source) => { scene.background = { ...(scene.background ?? { loop: true }), source: source ?? '' }; void stage.setScene(scene); changed(); },
        })),
        isStartScene
          ? h('p', { class: 'ed-note' }, 'The badge opens on this scene.')
          : h('div', { class: 'ed-inline-actions' }, button('Open the badge on this scene', () => {
            config.settings = { ...(config.settings ?? {}), defaultScene: scene.id };
            changed();
            renderTab();
          }, { small: true })),
      ),
      h('section', { class: 'ed-section' },
        sectionHeader('Behaviour'),
        field('Starting animation', select(animationOptions(), scene.defaultAnimation, (value) => { scene.defaultAnimation = value; changed(); }),
          'Plays whenever nothing else is happening.'),
        field('Starting mood', select(moodOptions('No mood'), scene.defaultMood ?? '', (value) => {
          if (value) scene.defaultMood = value; else delete scene.defaultMood;
          changed();
        })),
        toggle('Move to another scene automatically', Boolean(rotation), (value) => {
          if (value) scene.sceneDuration = { min: 90000, max: 150000 };
          else delete scene.sceneDuration;
          renderRotation();
          changed();
        }),
        rotationRange,
      ),
      h('section', { class: 'ed-section' },
        sectionHeader('Scene transitions', 'Played over the scene as it appears and leaves.'),
        portalPicker('entryAnimation', 'Arrival animation', 'Plays when the badge switches to this scene.'),
        portalPicker('exitAnimation', 'Departure animation', 'Plays when the badge leaves this scene.'),
      ),
    ];
  };

  const renderAnimations = (): HTMLElement[] => {
    const list = scene.animations.map((animation, index) => {
      const key = `animation:${animation.id}`;
      const meta: (string | HTMLElement)[] = [];
      if (animation.id === scene.defaultAnimation) meta.push(h('span', { class: 'ed-chip is-accent' }, 'Starting'));
      meta.push(describePlayback(animation));
      for (const trigger of animation.interactionTriggers ?? []) meta.push(TRIGGER_LABELS[trigger.type]);
      if (animation.setsMood) meta.push(`→ ${displayName(animation.setsMood)}`);
      if (!animation.source) meta.push(h('span', { class: 'ed-chip is-warning' }, 'Needs video'));

      return card(key, displayName(animation.id), meta, () => {
        const playbackMode = animation.loopCount ? 'repeat' : animation.loop ? 'loop' : 'once';
        const repeatField = h('div');
        const renderRepeat = (): void => {
          repeatField.replaceChildren(animation.loopCount
            ? field('Repeat count', numberInput(animation.loopCount, (value) => { animation.loopCount = Math.max(1, Math.round(value)); changed(); }, { min: 1, step: 1, suffix: 'times' }))
            : h('span'));
        };
        renderRepeat();
        return [
          field('Name', nameInput(animation.id, () => scene.animations.filter((other) => other !== animation).map((other) => other.id), (next) => {
            const wasOpen = openKeys.delete(key);
            renameAnimation(scene, animation.id, next);
            if (wasOpen) openKeys.add(`animation:${next}`);
            if (selectedKey === key) selectedKey = `animation:${next}`;
            renderTab();
            renderQuickPicks();
          })),
          field('Video', videoPicker({
            source: animation.source || undefined,
            label: 'Video',
            describe,
            upload: context.upload,
            onChange: (source) => { animation.source = source ?? ''; renderQuickPicks(); changed(); },
            onPreview: () => playAnimation(animation),
          })),
          field('Playback', segmented([
            { value: 'once', label: 'Once' },
            { value: 'repeat', label: 'Repeat' },
            { value: 'loop', label: 'Loop' },
          ], playbackMode, (mode) => {
            animation.loop = mode === 'loop';
            if (mode === 'repeat') animation.loopCount = animation.loopCount ?? 2;
            else delete animation.loopCount;
            renderRepeat();
            changed();
          }, 'Playback')),
          repeatField,
          transitionField(animation, 'entryTransition', 'Lead-in'),
          transitionField(animation, 'exitTransition', 'Lead-out'),
          field('Afterwards, switch mood to', select(moodOptions('Keep current mood'), animation.setsMood ?? '', (value) => {
            if (value) animation.setsMood = value; else delete animation.setsMood;
            changed();
          })),
          h('div', { class: 'ed-subsection' },
            h('h4', null, 'Triggers'),
            h('p', { class: 'ed-hint' }, 'What makes this animation play.'),
            triggerList(animation, ['touch', 'rub', 'random'], `animation:${index}`, { emptyText: 'No triggers: it only plays as the starting animation or as a lead-in or lead-out.' }),
          ),
          h('div', { class: 'ed-item-footer' },
            button('Delete animation', () => {
              if (scene.animations.length <= 1) return;
              if (!window.confirm(`Delete "${displayName(animation.id)}"?`)) return;
              deleteAnimation(scene, animation.id);
              if (scene.defaultAnimation === animation.id) scene.defaultAnimation = scene.animations[0]?.id ?? '';
              renderTab();
              renderQuickPicks();
              updateRegions();
              changed();
            }, { icon: 'trash', small: true, variant: 'danger' }),
          ),
        ];
      }, () => playAnimation(animation));
    });

    const add = button('Add animation', () => {
      const id = uniqueId('new-animation', scene.animations.map((animation) => animation.id));
      scene.animations.push({ id, source: '', loop: false });
      openKeys.add(`animation:${id}`);
      renderTab();
      renderQuickPicks();
      changed();
    }, { icon: 'plus', small: true });

    return [h('section', { class: 'ed-section' },
      sectionHeader('Animations', 'Character videos. Open one to change its video, playback and triggers.', add),
      h('div', { class: 'ed-list' }, list),
    )];
  };

  const renderLayers = (): HTMLElement[] => {
    const layers = scene.additionalLayers ?? [];
    const list = layers.map((layer, index) => {
      const key = `layer:${index}`;
      const layerChanged = (): void => { stage.refreshLayers(); changed(); };
      const meta: (string | HTMLElement)[] = [layer.layerPriority === 'foreground' ? 'In front' : 'Behind'];
      if (layer.targetAnimation) meta.push(`Plays ${displayName(layer.targetAnimation)}`);
      if (!layer.source) meta.push(h('span', { class: 'ed-chip is-warning' }, 'Needs video'));

      return card(key, displayName(layer.id ?? `Layer ${index + 1}`), meta, () => {
        const customSize = h('div');
        const renderCustomSize = (): void => {
          const size = layer.size ?? { width: '100%', height: '100%' };
          customSize.replaceChildren(sizePreset(layer) === 'custom'
            ? h('div', { class: 'ed-grid-2' },
              field('Width', textInput(size.width, (value) => { layer.size = { ...size, width: value.trim() || 'auto' }; layerChanged(); }, { commitOnBlur: true, placeholder: '100%, 240px or auto' })),
              field('Height', textInput(size.height, (value) => { layer.size = { ...size, height: value.trim() || 'auto' }; layerChanged(); }, { commitOnBlur: true, placeholder: '100%, 240px or auto' })))
            : h('span'));
        };
        renderCustomSize();

        const alignment = layer.alignment ?? { horizontal: 'left', vertical: 'top' };
        const anchor = h('div', { class: 'ed-anchor', role: 'radiogroup', 'aria-label': 'Anchor' });
        const verticals = ['top', 'center', 'bottom'] as const;
        const horizontals = ['left', 'center', 'right'] as const;
        for (const vertical of verticals) for (const horizontal of horizontals) {
          const cell = h('button', { type: 'button', role: 'radio', class: 'ed-anchor-cell', title: `${vertical} ${horizontal}`, 'aria-label': `${vertical} ${horizontal}` }, h('span'));
          cell.setAttribute('aria-checked', String(alignment.horizontal === horizontal && alignment.vertical === vertical));
          cell.addEventListener('click', () => {
            layer.alignment = { horizontal, vertical };
            for (const other of anchor.children) other.setAttribute('aria-checked', String(other === cell));
            layerChanged();
          });
          anchor.appendChild(cell);
        }

        const position = layer.position ?? { x: 0, y: 0 };
        const triggerArea = h('div');
        const renderTriggerArea = (): void => {
          triggerArea.replaceChildren(layer.targetAnimation
            ? triggerList(layer, ['touch', 'random'], `layer:${index}`, { emptyText: 'No triggers yet.' })
            : h('span'));
        };
        renderTriggerArea();

        return [
          field('Name', nameInput(layer.id ?? '', () => layers.filter((other) => other !== layer).map((other) => other.id ?? ''), (next) => {
            if (layer.id) renameLayer(scene, layer.id, next);
            if (next) layer.id = next; else delete layer.id;
            renderTab();
          }, false), 'Moods use this name to change the layer.'),
          field('Video', videoPicker({
            source: layer.source || undefined,
            label: 'Layer video',
            describe,
            upload: context.upload,
            onChange: (source) => { layer.source = source ?? ''; layerChanged(); },
          })),
          field('Placement', segmented([
            { value: 'background', label: 'Behind character' },
            { value: 'foreground', label: 'In front of character' },
          ], layer.layerPriority, (value) => { layer.layerPriority = value; layerChanged(); }, 'Placement')),
          field('Stack order', numberInput(layer.layerOrder, (value) => { layer.layerOrder = Math.round(value); layerChanged(); }, { step: 1 }),
            'Layers with a higher number sit on top of lower ones.'),
          toggle('Loop', layer.loop, (value) => { layer.loop = value; layerChanged(); }),
          h('div', { class: 'ed-subsection' },
            h('h4', null, 'Size and position'),
            field('Size', select([
              { value: 'fill', label: 'Fill the screen' },
              { value: 'width', label: 'Full width' },
              { value: 'height', label: 'Full height' },
              { value: 'natural', label: 'Original size' },
              { value: 'custom', label: 'Custom' },
            ], sizePreset(layer), (value) => {
              const preset = SIZE_PRESETS[value];
              // "Custom" starts from a half-width box so the custom fields appear.
              layer.size = preset ? { ...preset } : { width: '50%', height: 'auto' };
              renderCustomSize();
              layerChanged();
            })),
            customSize,
            h('div', { class: 'ed-anchor-row' },
              field('Anchor', anchor),
              h('div', { class: 'ed-grid-2 ed-grow' },
                field('Offset X', numberInput(position.x, (value) => { layer.position = { ...(layer.position ?? { x: 0, y: 0 }), x: value }; layerChanged(); }, { step: 1, suffix: 'px' })),
                field('Offset Y', numberInput(position.y, (value) => { layer.position = { ...(layer.position ?? { x: 0, y: 0 }), y: value }; layerChanged(); }, { step: 1, suffix: 'px' })),
              ),
            ),
          ),
          h('div', { class: 'ed-subsection' },
            h('h4', null, 'Interaction'),
            field('Plays an animation', select([{ value: '', label: 'Nothing' }, ...animationOptions()], layer.targetAnimation ?? '', (value) => {
              if (value) layer.targetAnimation = value; else { delete layer.targetAnimation; delete layer.interactionTriggers; }
              renderTriggerArea();
              updateRegions();
              changed();
            }), 'Optional. Lets this layer start a character animation.'),
            triggerArea,
          ),
          h('div', { class: 'ed-item-footer' },
            button('Delete layer', () => {
              if (!window.confirm(`Delete layer "${displayName(layer.id ?? `Layer ${index + 1}`)}"?`)) return;
              deleteLayer(scene, index);
              if (!scene.additionalLayers?.length) delete scene.additionalLayers;
              openKeys.clear();
              stage.refreshLayers();
              renderTab();
              updateRegions();
              changed();
            }, { icon: 'trash', small: true, variant: 'danger' }),
          ),
        ];
      });
    });

    const add = button('Add layer', () => {
      const layer: AdditionalLayer = {
        id: uniqueId('layer', layers.map((item) => item.id ?? '')),
        source: '',
        loop: true,
        layerOrder: 1,
        layerPriority: 'foreground',
      };
      (scene.additionalLayers ??= []).push(layer);
      openKeys.add(`layer:${scene.additionalLayers.length - 1}`);
      renderTab();
      changed();
    }, { icon: 'plus', small: true });

    return [h('section', { class: 'ed-section' },
      sectionHeader('Layers', 'Extra videos drawn behind or in front of the character, like a tail or a name tag.', add),
      list.length ? h('div', { class: 'ed-list' }, list) : emptyState('This scene has no layers.'),
    )];
  };

  const renderMoods = (): HTMLElement[] => {
    const moods = scene.moods ?? [];
    const targetOptions = (): Option[] => [
      ...scene.animations.map((animation) => ({ value: animation.id, label: `Animation · ${displayName(animation.id)}` })),
      ...(scene.additionalLayers ?? []).filter((layer) => layer.id).map((layer) => ({ value: layer.id!, label: `Layer · ${displayName(layer.id!)}` })),
    ];

    const list = moods.map((mood: Mood, index) => {
      const key = `mood:${index}`;
      const meta: (string | HTMLElement)[] = [];
      if (mood.id === scene.defaultMood) meta.push(h('span', { class: 'ed-chip is-accent' }, 'Starting'));
      const effectCount = mood.setAnimations?.length ?? 0;
      meta.push(`${effectCount} ${effectCount === 1 ? 'effect' : 'effects'}`);
      if (mood.interactionTriggers?.length) meta.push('Random');

      return card(key, displayName(mood.id), meta, () => {
        const effects = h('div', { class: 'ed-effects' });
        const renderEffects = (): void => {
          const rows = (mood.setAnimations ?? []).map((effect, effectIndex) => {
            const options = targetOptions();
            if (!options.some((option) => option.value === effect.animation)) options.unshift({ value: effect.animation, label: `${effect.animation} (missing)` });
            return h('div', { class: 'ed-effect' },
              h('div', { class: 'ed-effect-row' },
                field('Changes', select(options, effect.animation, (value) => { effect.animation = value; changed(); })),
                field('Speed', numberInput(effect.speed ?? 1, (value) => { effect.speed = value; changed(); }, { min: 0.1, max: 4, step: 0.25, suffix: '×' })),
                button('', () => {
                  mood.setAnimations?.splice(effectIndex, 1);
                  renderEffects();
                  changed();
                }, { icon: 'trash', title: 'Remove effect', small: true, variant: 'ghost' }),
              ),
              field('Swap video (optional)', videoPicker({
                source: effect.source,
                label: 'Replacement video',
                describe,
                upload: context.upload,
                optional: true,
                onChange: (source) => { if (source) effect.source = source; else delete effect.source; changed(); },
              })),
            );
          });
          const add = button('Add effect', () => {
            const first = targetOptions()[0];
            if (!first) return;
            (mood.setAnimations ??= []).push({ animation: first.value, speed: 1 });
            renderEffects();
            changed();
          }, { icon: 'plus', small: true });
          effects.replaceChildren(...(rows.length ? rows : [emptyState('No effects yet.')]), add);
        };
        renderEffects();

        return [
          field('Name', nameInput(mood.id, () => moods.filter((other) => other !== mood).map((other) => other.id), (next) => {
            renameMood(scene, mood.id, next);
            renderTab();
          })),
          h('div', { class: 'ed-subsection' },
            h('h4', null, 'Effects'),
            h('p', { class: 'ed-hint' }, 'How the scene changes while this mood is active.'),
            effects,
          ),
          h('div', { class: 'ed-subsection' },
            h('h4', null, 'Random activation'),
            h('p', { class: 'ed-hint' }, 'Optional. Switches to this mood now and then, then back to the starting mood. Animations can also set it.'),
            triggerList(mood, ['random'], `mood:${index}`, { mood: true, emptyText: 'Never activates on its own.' }),
          ),
          h('div', { class: 'ed-item-footer' },
            button('Delete mood', () => {
              if (!window.confirm(`Delete mood "${displayName(mood.id)}"?`)) return;
              deleteMood(scene, mood.id);
              if (!scene.moods?.length) delete scene.moods;
              openKeys.clear();
              renderTab();
              changed();
            }, { icon: 'trash', small: true, variant: 'danger' }),
          ),
        ];
      });
    });

    const add = button('Add mood', () => {
      const id = uniqueId('mood', moods.map((mood) => mood.id));
      (scene.moods ??= []).push({ id, setAnimations: [] });
      openKeys.add(`mood:${scene.moods.length - 1}`);
      renderTab();
      changed();
    }, { icon: 'plus', small: true });

    return [h('section', { class: 'ed-section' },
      sectionHeader('Moods', 'Moods change the speed or video of animations and layers, for example a faster tail when happy.', add),
      list.length ? h('div', { class: 'ed-list' }, list) : emptyState('This scene has no moods.'),
    )];
  };

  const TABS: { id: Tab; label: string; count?: () => number; render: () => HTMLElement[] }[] = [
    { id: 'general', label: 'General', render: renderGeneral },
    { id: 'animations', label: 'Animations', count: () => scene.animations.length, render: renderAnimations },
    { id: 'layers', label: 'Layers', count: () => scene.additionalLayers?.length ?? 0, render: renderLayers },
    { id: 'moods', label: 'Moods', count: () => scene.moods?.length ?? 0, render: renderMoods },
  ];

  function renderTabBar(): void {
    tabBar.replaceChildren(...TABS.map((item) => {
      const tabButton = h('button', { type: 'button', role: 'tab', class: 'ed-tab' },
        item.label,
        item.count ? h('span', { class: 'ed-tab-count' }, String(item.count())) : null,
      );
      tabButton.setAttribute('aria-selected', String(item.id === tab));
      tabButton.addEventListener('click', () => { tab = item.id; renderTab(); });
      return tabButton;
    }));
  }

  function renderTab(): void {
    stage.cancelDrawing();
    renderTabBar();
    const scrollTop = tabContent.scrollTop;
    tabContent.replaceChildren(...TABS.find((item) => item.id === tab)!.render());
    tabContent.scrollTop = scrollTop;
  }

  // ── Page ──

  title.textContent = displayName(scene.id);
  const header = h('header', { class: 'se-header' },
    button('Scenes', actions.onBack, { icon: 'back', variant: 'ghost' }),
    title,
    h('div', { class: 'se-header-actions' },
      button('Duplicate', actions.onDuplicate, { icon: 'copy', small: true }),
      config.scenes.length > 1 ? button('Delete', actions.onDelete, { icon: 'trash', small: true, variant: 'danger' }) : null,
    ),
  );

  const element = h('section', { class: 'scene-editor', 'aria-label': `Edit scene ${displayName(scene.id)}` },
    header,
    h('div', { class: 'se-body' }, previewPane, h('div', { class: 'se-panel' }, tabBar, tabContent)),
  );

  void stage.setScene(scene);
  const start = scene.animations.find((animation) => animation.id === scene.defaultAnimation) ?? scene.animations[0];
  renderQuickPicks();
  if (start) playAnimation(start);
  renderTab();
  updateRegions();

  return { element, destroy: () => stage.destroy() };
}
