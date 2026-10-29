import QRCode from 'qrcode';
import type { AnimationConfig, Scene } from './types';
import { loadMedia, saveMedia, saveProfile, type LocalProfile } from './profile-store';
import { createBlankScene, displayName, toEditableConfig, uniqueId, validateConfig, type ConfigIssue } from './editor/config-model';
import { h, icon } from './editor/dom';
import { button, field, numberInput, sectionHeader, select, textInput, toggle } from './editor/fields';
import { createSceneEditor, type EditorContext, type SceneEditorHandle } from './editor/scene-editor';
import { sceneThumbnail } from './editor/thumbnails';

const mediaKey = (scene: string, animation: string): string => `${scene}:${animation}`;

const VIDEO_FILE = /\.(webm|mp4|m4v|mov|ogv)$/i;

export interface BadgeUiOptions {
  /** Called when the tilt trigger fires. */
  onMotion: () => void;
  /** Called when the setup screen opens or closes, so the badge can pause. */
  onEditorOpenChange?: (open: boolean) => void;
}

type MainTab = 'scenes' | 'profile' | 'settings';

export function mountBadgeUi(profile: LocalProfile, config: AnimationConfig, options: BadgeUiOptions): void {
  // ── Floating buttons and QR page ──

  const qrButton = h('button', { type: 'button', class: 'badge-fab', 'aria-label': 'Show badge QR code' }, icon('qr'));
  const editButton = h('button', { type: 'button', class: 'badge-fab', 'aria-label': 'Edit badge' }, icon('settings'));
  document.body.appendChild(h('div', { id: 'badge-header', class: 'auto-hide' }, qrButton, editButton));

  const qrCanvas = h('canvas', { id: 'badge-qr-canvas' });
  const qrUrl = h('p', { id: 'badge-qr-url' });
  const copyButton = button('Copy link', async () => {
    try {
      await navigator.clipboard.writeText(qrUrl.textContent ?? '');
      copyButton.querySelector('span')!.textContent = 'Copied';
      window.setTimeout(() => { copyButton.querySelector('span')!.textContent = 'Copy link'; }, 1600);
    } catch { /* The QR code stays available. */ }
  }, { icon: 'copy' });
  const qrPage = h('section', { id: 'badge-qr-page', class: 'badge-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Badge link' },
    h('div', { class: 'qr-card' },
      h('div', { class: 'qr-card-heading' },
        h('h1', null, profile.title || 'Badge link'),
        button('', () => { qrPage.hidden = true; }, { icon: 'close', title: 'Close', variant: 'ghost' }),
      ),
      qrCanvas, qrUrl, copyButton,
    ),
  );
  qrPage.hidden = true;
  qrPage.addEventListener('click', (event) => { if (event.target === qrPage) qrPage.hidden = true; });
  document.body.appendChild(qrPage);

  const openQr = async (): Promise<void> => {
    qrPage.hidden = false;
    const url = profile.shareUrl || window.location.href;
    qrUrl.textContent = url;
    try { await QRCode.toCanvas(qrCanvas, url, { width: 280, margin: 2, color: { dark: '#111827', light: '#ffffff' } }); }
    catch { qrUrl.textContent = `Could not encode this link: ${url}`; }
  };
  qrButton.addEventListener('click', () => void openQr());

  // A long press anywhere on the avatar opens the QR page.
  let holdTimer = 0;
  let openedByHold = false;
  const mascot = document.getElementById('mascot-container')!;
  mascot.addEventListener('pointerdown', () => { openedByHold = false; holdTimer = window.setTimeout(() => { openedByHold = true; void openQr(); }, 600); });
  const clearHold = (): void => window.clearTimeout(holdTimer);
  mascot.addEventListener('pointerup', clearHold);
  mascot.addEventListener('pointercancel', clearHold);
  mascot.addEventListener('click', (event) => { if (openedByHold) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);

  // ── Tilt trigger (works as soon as it is switched on) ──

  let motionActive = profile.motionEnabled;
  let lastMotion = 0;
  let motionStatusText = 'Tilt the phone to play the look-around animation.';
  const motionListeners = new Set<(text: string) => void>();
  const setMotionStatus = (text: string): void => { motionStatusText = text; for (const listener of motionListeners) listener(text); };
  window.addEventListener('deviceorientation', (event) => {
    if (!motionActive || Date.now() - lastMotion < 1200) return;
    if (Math.abs(event.beta ?? 0) > 35 || Math.abs(event.gamma ?? 0) > 35) {
      lastMotion = Date.now();
      options.onMotion();
      setMotionStatus(`Tilt detected (${Math.round(event.beta ?? 0)}°, ${Math.round(event.gamma ?? 0)}°).`);
    }
  });

  // ── Setup screen ──

  const root = h('section', { id: 'badge-editor', class: 'ed-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Badge setup' });
  root.hidden = true;
  document.body.appendChild(root);

  let draft: AnimationConfig = toEditableConfig(config);
  let draftProfile = { title: '', avatarName: '', shareUrl: '', motionEnabled: false, dayNightEnabled: false };
  let mediaNames: Record<string, string> = {};
  let dirty = false;
  let mainTab: MainTab = 'scenes';
  let sceneEditor: SceneEditorHandle | null = null;
  let issues: ConfigIssue[] = [];

  const dirtyBadge = h('span', { class: 'ed-dirty', role: 'status' });
  const saveButton = button('Save', () => void save(), { variant: 'primary' });
  const markDirty = (): void => {
    dirty = true;
    dirtyBadge.textContent = 'Unsaved changes';
    if (issues.length) refreshIssues();
  };

  const issuesBanner = h('div', { class: 'ed-issues', role: 'alert' });
  const mainTabs = h('nav', { class: 'ed-tabs ed-main-tabs', role: 'tablist' });
  const main = h('main', { class: 'ed-main' });

  const topbar = h('header', { class: 'ed-topbar' },
    h('div', { class: 'ed-topbar-title' }, h('h1', null, 'Badge setup'), dirtyBadge),
    h('div', { class: 'ed-topbar-actions' }, button('Cancel', () => closeEditor(), { variant: 'ghost' }), saveButton),
  );
  root.append(topbar, issuesBanner, mainTabs, main);

  const upload = async (file: File): Promise<string> => {
    if (!file.type.startsWith('video/') && !VIDEO_FILE.test(file.name)) throw new Error('choose a video file (WebM or MP4).');
    const id = `upload-${crypto.randomUUID()}`;
    await saveMedia(id, file);
    const source = `local:${id}`;
    mediaNames[source] = file.name.replace(/\.[a-z0-9]+$/i, '');
    return source;
  };

  const editorContext = (): EditorContext => ({ config: draft, mediaNames, upload, markDirty });

  function refreshIssues(): void {
    issues = validateConfig(draft);
    issuesBanner.hidden = issues.length === 0;
    if (!issues.length) return;
    issuesBanner.replaceChildren(
      h('div', { class: 'ed-issues-title' }, icon('alert'), h('strong', null, `Fix ${issues.length === 1 ? 'this' : `these ${issues.length}`} before saving`)),
      h('ul', null, issues.map((issue) => {
        const scene = draft.scenes.find((item) => item.id === issue.sceneId);
        const item = h('li', null);
        if (scene) item.append(h('button', { type: 'button', class: 'ed-link', onclick: () => openScene(scene) }, issue.message));
        else item.append(issue.message);
        return item;
      })),
    );
  }

  // ── Scenes tab ──

  const sceneIssues = (scene: Scene): number => validateConfig({ ...draft, scenes: [scene] }).filter((issue) => issue.sceneId === scene.id).length;

  const renderScenes = (): HTMLElement[] => {
    const startScene = draft.settings?.defaultScene ?? draft.scenes[0]?.id;
    const cards = draft.scenes.map((scene) => {
      const image = h('img', { class: 'scene-card-image', alt: '' });
      const placeholder = h('div', { class: 'scene-card-placeholder' }, icon('film'));
      void sceneThumbnail(scene).then((url) => {
        if (!url) return;
        image.src = url;
        placeholder.remove();
      });
      const animationCount = scene.animations.length;
      const layerCount = scene.additionalLayers?.length ?? 0;
      const problems = sceneIssues(scene);
      return h('button', { type: 'button', class: 'scene-card', onclick: () => openScene(scene), 'aria-label': `Edit ${displayName(scene.id)}` },
        h('div', { class: 'scene-card-media' }, image, placeholder,
          scene.id === startScene ? h('span', { class: 'scene-card-badge' }, 'Starting scene') : null),
        h('div', { class: 'scene-card-caption' },
          h('span', { class: 'scene-card-title' }, displayName(scene.id)),
          h('span', { class: 'scene-card-meta' },
            `${animationCount} ${animationCount === 1 ? 'animation' : 'animations'}`,
            layerCount ? ` · ${layerCount} ${layerCount === 1 ? 'layer' : 'layers'}` : '',
          ),
          problems ? h('span', { class: 'ed-chip is-warning' }, `${problems} to fix`) : null,
        ),
      );
    });
    const addCard = h('button', { type: 'button', class: 'scene-card scene-card-add', onclick: () => {
      const scene = createBlankScene(draft);
      draft.scenes.push(scene);
      markDirty();
      openScene(scene);
    } },
    h('div', { class: 'scene-card-media' }, h('span', { class: 'scene-card-add-icon' }, icon('plus'))),
    h('div', { class: 'scene-card-caption' }, h('span', { class: 'scene-card-title' }, 'New scene'), h('span', { class: 'scene-card-meta' }, 'Start from a blank scene')),
    );
    return [
      sectionHeader('Scenes', 'The badge moves between these scenes. Select one to edit its videos and behaviour!'),
      h('div', { class: 'scene-gallery' }, cards, addCard),
    ];
  };

  // ── Profile tab ──

  const renderProfile = (): HTMLElement[] => {
    const nfc = (window as any).NDEFReader;
    const bluetooth = (navigator as any).bluetooth;
    const nfcStatus = h('p', { class: 'ed-hint' }, nfc ? 'NFC is available on this device.' : 'NFC is not available in this browser or device.');
    const bluetoothStatus = h('p', { class: 'ed-hint' }, bluetooth ? 'Bluetooth is available. Badge exchange needs a compatible badge service.' : 'Bluetooth exchange is not available on this device.');
    const motionStatus = h('p', { class: 'ed-hint' }, motionStatusText);
    const onMotionStatus = (text: string): void => { motionStatus.textContent = text; };
    motionListeners.clear();
    motionListeners.add(onMotionStatus);
    const hour = new Date().getHours();
    const dayStatus = h('p', { class: 'ed-hint' }, `Right now it is ${hour >= 7 && hour < 19 ? 'day' : 'night'} (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}). Day/night scenes are not available yet.`);

    const urlInput = textInput(draftProfile.shareUrl, (value) => { draftProfile.shareUrl = value; urlInput.setCustomValidity(''); markDirty(); }, { type: 'url', placeholder: 'https://example.com' });
    urlInput.id = 'share-url';

    const readNfc = async (): Promise<void> => {
      if (!nfc) return;
      try {
        const reader = new nfc();
        await reader.scan();
        reader.onreading = (event: any) => {
          for (const record of event.message.records) if (record.recordType === 'url') {
            const url = new TextDecoder().decode(record.data);
            draftProfile.shareUrl = url;
            urlInput.value = url;
            markDirty();
            nfcStatus.textContent = `Received ${url}. Save to keep this link.`;
          }
        };
        nfcStatus.textContent = 'Ready. Hold the phones together.';
      } catch (error) { nfcStatus.textContent = `Could not read by NFC: ${(error as Error).message}`; }
    };
    const writeNfc = async (): Promise<void> => {
      if (!nfc) return;
      try {
        await new nfc().write({ records: [{ recordType: 'url', data: draftProfile.shareUrl || window.location.href }] });
        nfcStatus.textContent = 'Link shared by NFC.';
      } catch (error) { nfcStatus.textContent = `Could not share by NFC: ${(error as Error).message}`; }
    };
    const nfcRead = button('Receive link', () => void readNfc(), { small: true });
    const nfcWrite = button('Share link', () => void writeNfc(), { small: true });
    nfcRead.disabled = !nfc;
    nfcWrite.disabled = !nfc;

    return [
      h('section', { class: 'ed-section ed-narrow' },
        sectionHeader('Badge', 'Shown on the QR page and shared with other badges.'),
        field('Badge title', textInput(draftProfile.title, (value) => { draftProfile.title = value; markDirty(); }, { maxLength: 48, placeholder: 'My Badge' })),
        field('Avatar name', textInput(draftProfile.avatarName, (value) => { draftProfile.avatarName = value; markDirty(); }, { maxLength: 48, placeholder: 'Avatar' })),
        field('Share link', urlInput, 'The QR code opens this address.'),
      ),
      h('section', { class: 'ed-section ed-narrow' },
        sectionHeader('Sharing'),
        h('div', { class: 'ed-capability' },
          h('div', null, h('strong', null, 'NFC'), nfcStatus),
          h('div', { class: 'ed-inline-actions' }, nfcRead, nfcWrite),
        ),
        h('div', { class: 'ed-capability' },
          h('div', null, h('strong', null, 'Bluetooth'), bluetoothStatus),
        ),
      ),
      h('section', { class: 'ed-section ed-narrow' },
        sectionHeader('Sensors'),
        h('div', { class: 'ed-capability' },
          h('div', null,
            toggle('Tilt trigger', draftProfile.motionEnabled, async (value) => {
              draftProfile.motionEnabled = value;
              motionActive = value;
              markDirty();
              const orientation = DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };
              if (value && orientation.requestPermission) {
                try {
                  const permission = await orientation.requestPermission();
                  if (permission !== 'granted') { draftProfile.motionEnabled = motionActive = false; renderMain(); }
                  setMotionStatus(permission === 'granted' ? 'Motion access granted. Tilt the phone to try it.' : 'Motion access was not granted.');
                } catch { draftProfile.motionEnabled = motionActive = false; setMotionStatus('Motion access is not available.'); }
              }
            }),
            motionStatus,
          ),
        ),
        h('div', { class: 'ed-capability' },
          h('div', null,
            toggle('Day/night mode', draftProfile.dayNightEnabled, (value) => { draftProfile.dayNightEnabled = value; markDirty(); }),
            dayStatus,
          ),
        ),
      ),
    ];
  };

  // ── Settings tab ──

  const renderSettings = (): HTMLElement[] => {
    const startScene = draft.settings?.defaultScene ?? draft.scenes[0]?.id ?? '';
    const rotation = { min: 90000, max: 150000 };
    const timed = draft.scenes.find((scene) => scene.sceneDuration)?.sceneDuration;
    if (timed) Object.assign(rotation, timed);
    const rotationStatus = h('p', { class: 'ed-hint' });
    const describeRotation = (): void => {
      const timedCount = draft.scenes.filter((scene) => scene.sceneDuration).length;
      rotationStatus.textContent = timedCount === draft.scenes.length
        ? 'Every scene moves on automatically.'
        : `${timedCount} of ${draft.scenes.length} scenes move on automatically. You can change this per scene.`;
    };
    describeRotation();

    const importInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'ed-hidden-file' });
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text()) as AnimationConfig;
        if (!parsed || !Array.isArray(parsed.scenes)) throw new Error('This file has no scenes.');
        if (!window.confirm(`Replace all scenes with the ${parsed.scenes.length} scenes in "${file.name}"?`)) return;
        draft = toEditableConfig(parsed);
        markDirty();
        refreshIssues();
        renderMain();
      } catch (error) {
        window.alert(`Could not import this file: ${(error as Error).message}`);
      }
    });

    return [
      h('section', { class: 'ed-section ed-narrow' },
        sectionHeader('Playback'),
        field('Starting scene', select(draft.scenes.map((scene) => ({ value: scene.id, label: displayName(scene.id) })), startScene, (value) => {
          draft.settings = { ...(draft.settings ?? {}), defaultScene: value };
          markDirty();
        }), 'The scene the badge shows when it starts.'),
      ),
      h('section', { class: 'ed-section ed-narrow' },
        sectionHeader('Scene rotation', 'How long each scene stays before the badge moves to another one.'),
        field('Stay on each scene for', h('div', { class: 'ed-range' },
          numberInput(rotation.min / 1000, (value) => { rotation.min = Math.round(value * 1000); }, { min: 1, step: 1, suffix: 's' }),
          h('span', { class: 'ed-range-sep' }, 'to'),
          numberInput(rotation.max / 1000, (value) => { rotation.max = Math.round(value * 1000); }, { min: 1, step: 1, suffix: 's' }),
        )),
        h('div', { class: 'ed-inline-actions' },
          button('Apply to all scenes', () => {
            if (rotation.min <= 0 || rotation.max < rotation.min) { window.alert('Enter a positive time range with the shortest time first.'); return; }
            for (const scene of draft.scenes) scene.sceneDuration = { ...rotation };
            markDirty();
            describeRotation();
          }, { small: true }),
          button('Turn off rotation', () => {
            for (const scene of draft.scenes) delete scene.sceneDuration;
            markDirty();
            describeRotation();
          }, { small: true, variant: 'ghost' }),
        ),
        rotationStatus,
      ),
      h('section', { class: 'ed-section ed-narrow' },
        sectionHeader('Backup', 'Save all scenes to a file, or load scenes from one. Uploaded videos stay on this device.'),
        h('div', { class: 'ed-inline-actions' },
          button('Export scenes', () => {
            const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
            const link = h('a', { href: URL.createObjectURL(blob), download: 'animations.json' });
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
          }, { icon: 'download', small: true }),
          h('label', { class: 'ed-button ed-button-subtle ed-button-small' }, icon('upload'), h('span', null, 'Import scenes'), importInput),
        ),
      ),
      h('section', { class: 'ed-section ed-narrow ed-danger-zone' },
        sectionHeader('Reset', 'Remove your changes and go back to the animations that came with the app.'),
        button('Restore built-in animations', async () => {
          if (!window.confirm('Remove all your scene changes and uploaded video choices? This cannot be undone.')) return;
          delete profile.animationConfig;
          profile.animationSources = {};
          profile.mediaNames = {};
          await saveProfile(profile);
          window.location.reload();
        }, { variant: 'danger', small: true }),
      ),
    ];
  };

  // ── Navigation ──

  const MAIN_TABS: { id: MainTab; label: string; render: () => HTMLElement[] }[] = [
    { id: 'scenes', label: 'Scenes', render: renderScenes },
    { id: 'profile', label: 'Profile', render: renderProfile },
    { id: 'settings', label: 'Settings', render: renderSettings },
  ];

  function renderMain(): void {
    mainTabs.replaceChildren(...MAIN_TABS.map((item) => {
      const tab = h('button', { type: 'button', role: 'tab', class: 'ed-tab', onclick: () => { mainTab = item.id; renderMain(); } }, item.label);
      tab.setAttribute('aria-selected', String(item.id === mainTab));
      return tab;
    }));
    main.replaceChildren(h('div', { class: 'ed-main-inner' }, MAIN_TABS.find((item) => item.id === mainTab)!.render()));
  }

  function setSceneView(open: boolean): void {
    mainTabs.hidden = open;
    main.hidden = open;
  }

  function closeScene(): void {
    sceneEditor?.destroy();
    sceneEditor = null;
    setSceneView(false);
    renderMain();
  }

  function openScene(scene: Scene): void {
    sceneEditor?.destroy();
    setSceneView(true);
    sceneEditor = createSceneEditor(editorContext(), scene, {
      onBack: closeScene,
      onRenamed: () => { if (issues.length) refreshIssues(); },
      onDuplicate: () => {
        const copy = structuredClone(scene);
        copy.id = uniqueId(`${scene.id}-copy`, draft.scenes.map((item) => item.id));
        draft.scenes.splice(draft.scenes.indexOf(scene) + 1, 0, copy);
        markDirty();
        openScene(copy);
      },
      onDelete: () => {
        if (draft.scenes.length <= 1) return;
        if (!window.confirm(`Delete the scene "${displayName(scene.id)}"?`)) return;
        draft.scenes = draft.scenes.filter((item) => item !== scene);
        if (draft.settings?.defaultScene === scene.id) draft.settings.defaultScene = draft.scenes[0].id;
        markDirty();
        closeScene();
      },
    });
    root.appendChild(sceneEditor.element);
  }

  function openEditor(): void {
    draft = toEditableConfig(config);
    draftProfile = {
      title: profile.title,
      avatarName: profile.avatarName,
      shareUrl: profile.shareUrl,
      motionEnabled: profile.motionEnabled,
      dayNightEnabled: profile.dayNightEnabled,
    };
    mediaNames = { ...profile.mediaNames };
    dirty = false;
    dirtyBadge.textContent = '';
    issues = [];
    issuesBanner.hidden = true;
    mainTab = 'scenes';
    // Previews use the badge's own screen shape so touch areas line up.
    const ratio = Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight);
    root.style.setProperty('--ed-stage-aspect', `${window.innerWidth} / ${window.innerHeight}`);
    root.style.setProperty('--ed-stage-ratio', String(ratio));
    root.style.setProperty('--ed-card-min', ratio < 1 ? '150px' : '240px');
    setSceneView(false);
    renderMain();
    // Point out problems in a saved setup right away (for example a scene
    // that lost its name), instead of waiting for Save.
    if (validateConfig(draft).length) refreshIssues();
    root.hidden = false;
    options.onEditorOpenChange?.(true);
  }

  function closeEditor(force = false): void {
    if (!force && dirty && !window.confirm('Discard your unsaved changes?')) return;
    sceneEditor?.destroy();
    sceneEditor = null;
    main.replaceChildren();
    root.hidden = true;
    motionActive = profile.motionEnabled;
    options.onEditorOpenChange?.(false);
  }

  async function save(): Promise<void> {
    if (!dirty) { closeEditor(true); return; }
    const url = draftProfile.shareUrl.trim();
    if (url) {
      try { new URL(url); } catch {
        mainTab = 'profile';
        sceneEditor?.destroy();
        sceneEditor = null;
        setSceneView(false);
        renderMain();
        const input = root.querySelector<HTMLInputElement>('#share-url');
        input?.setCustomValidity('Enter a complete address, including https://');
        input?.reportValidity();
        return;
      }
    }
    refreshIssues();
    if (issues.length) { issuesBanner.scrollIntoView({ block: 'nearest' }); return; }

    saveButton.disabled = true;
    profile.title = draftProfile.title.trim() || 'My Badge';
    profile.avatarName = draftProfile.avatarName.trim() || 'Avatar';
    profile.shareUrl = url;
    profile.motionEnabled = draftProfile.motionEnabled;
    profile.dayNightEnabled = draftProfile.dayNightEnabled;
    profile.animationConfig = draft;
    profile.animationSources = {};
    profile.mediaNames = mediaNames;
    try {
      await saveProfile(profile);
      window.location.reload();
    } catch (error) {
      saveButton.disabled = false;
      window.alert(`Could not save: ${(error as Error).message}`);
    }
  }

  editButton.addEventListener('click', openEditor);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!qrPage.hidden) { qrPage.hidden = true; return; }
    if (root.hidden || (event.target as HTMLElement).closest('select')) return;
    if (sceneEditor) closeScene();
    else closeEditor();
  });
}

export async function applyProfileAnimations(config: AnimationConfig, profile: LocalProfile): Promise<void> {
  for (const scene of config.scenes) for (const animation of scene.animations) {
    const source = profile.animationSources[mediaKey(scene.id, animation.id)];
    if (!source?.startsWith('local:')) continue;
    const blob = await loadMedia(source.slice('local:'.length));
    if (blob) animation.source = source;
  }
}
