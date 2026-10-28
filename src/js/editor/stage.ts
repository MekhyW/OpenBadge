import type { Scene, TouchRegion } from '../types';
import { getCachedBlobUrl } from '../config-loader';
import { applyLayerPlacement, layerZIndex } from '../layer-layout';
import { h } from './dom';

export interface StageRegion {
  key: string;
  label: string;
  region: TouchRegion;
  active?: boolean;
}

function makeVideo(className: string): HTMLVideoElement {
  const video = h('video', { class: className });
  video.muted = true;
  video.playsInline = true;
  video.loop = true;
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;
  video.preload = 'auto';
  return video;
}

/**
 * The editor's live preview: the scene's background, layers and a chosen
 * character video stacked exactly as the badge stacks them. It renders at
 * the badge's real screen size and is scaled down to fit, so layer offsets
 * and touch areas line up with what the badge shows.
 */
export class SceneStage {
  readonly element: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly background = makeVideo('stage-video stage-background');
  private readonly character = makeVideo('stage-video stage-character');
  private layers: HTMLVideoElement[] = [];
  private readonly logicalWidth: number;
  private readonly logicalHeight: number;
  private readonly resizeObserver: ResizeObserver;
  private scene: Scene | null = null;
  private loadToken = 0;
  private characterToken = 0;
  private playing = true;
  private layersVisible = true;
  private regions: StageRegion[] = [];
  private regionsVisible = false;
  private drawing: ((region: TouchRegion | null) => void) | null = null;

  constructor() {
    this.logicalWidth = Math.max(1, window.innerWidth);
    this.logicalHeight = Math.max(1, window.innerHeight);
    this.canvas = h('div', { class: 'stage-canvas' }, this.background, this.character);
    this.canvas.style.width = `${this.logicalWidth}px`;
    this.canvas.style.height = `${this.logicalHeight}px`;
    this.character.style.zIndex = '10';
    this.overlay = h('div', { class: 'stage-overlay' });
    this.element = h('div', { class: 'stage' }, this.canvas, this.overlay);
    this.element.style.aspectRatio = `${this.logicalWidth} / ${this.logicalHeight}`;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.element);
    this.bindDrawing();
  }

  private fit(): void {
    const scale = this.element.clientWidth / this.logicalWidth;
    this.canvas.style.transform = `scale(${scale})`;
  }

  private async setSource(video: HTMLVideoElement, source: string | undefined): Promise<boolean> {
    if (!source) { video.removeAttribute('src'); video.load(); return false; }
    try {
      const url = await getCachedBlobUrl(source);
      if (video.src !== url) video.src = url;
      if (this.playing) void video.play().catch(() => undefined);
      return true;
    } catch {
      video.removeAttribute('src');
      return false;
    }
  }

  /** Load the scene's background and layers. The character slot is set with playCharacter. */
  async setScene(scene: Scene): Promise<void> {
    this.scene = scene;
    const token = ++this.loadToken;
    await this.setSource(this.background, scene.background?.source);
    if (token !== this.loadToken) return;
    this.refreshLayers();
  }

  /** Rebuild layer videos after a layer was added, removed or moved. */
  refreshLayers(): void {
    for (const video of this.layers) { video.pause(); video.remove(); }
    this.layers = [];
    for (const layer of this.scene?.additionalLayers ?? []) {
      const video = makeVideo('stage-video stage-layer');
      video.loop = true;
      video.style.zIndex = String(layerZIndex(layer));
      video.hidden = !this.layersVisible;
      applyLayerPlacement(video, layer);
      this.canvas.appendChild(video);
      this.layers.push(video);
      void this.setSource(video, layer.source);
    }
  }

  /** Play any video in the character slot (an animation, a transition or a portal). */
  async playCharacter(source: string | undefined, onTop = false): Promise<void> {
    const token = ++this.characterToken;
    this.character.style.zIndex = onTop ? '40' : '10';
    this.character.style.visibility = 'hidden';
    const ok = await this.setSource(this.character, source);
    if (token !== this.characterToken) return;
    if (ok) {
      this.character.currentTime = 0;
      this.character.style.visibility = '';
    }
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    for (const video of this.videos()) {
      if (!video.getAttribute('src')) continue;
      if (playing) void video.play().catch(() => undefined);
      else video.pause();
    }
  }

  get isPlaying(): boolean { return this.playing; }

  setLayersVisible(visible: boolean): void {
    this.layersVisible = visible;
    for (const video of this.layers) video.hidden = !visible;
  }

  setRegions(regions: StageRegion[], visible: boolean): void {
    this.regions = regions;
    this.regionsVisible = visible;
    this.renderRegions();
  }

  private renderRegions(preview?: TouchRegion): void {
    this.overlay.replaceChildren();
    const shown = this.regionsVisible ? this.regions : this.regions.filter((item) => item.active);
    for (const item of shown) this.overlay.appendChild(this.regionBox(item.region, item.label, item.active));
    if (preview) this.overlay.appendChild(this.regionBox(preview, 'New area', true));
  }

  private regionBox(region: TouchRegion, label: string, active?: boolean): HTMLElement {
    return h('div', {
      class: `stage-region${active ? ' active' : ''}`,
      style: {
        left: `${region.x * 100}%`,
        top: `${region.y * 100}%`,
        width: `${region.width * 100}%`,
        height: `${region.height * 100}%`,
      },
    }, h('span', null, label));
  }

  /** Let the user drag out a touch area. Resolves with null when cancelled. */
  drawRegion(): Promise<TouchRegion | null> {
    this.drawing?.(null);
    this.element.classList.add('drawing');
    return new Promise((resolve) => {
      this.drawing = (region) => {
        this.drawing = null;
        this.element.classList.remove('drawing');
        this.renderRegions();
        resolve(region);
      };
    });
  }

  cancelDrawing(): void { this.drawing?.(null); }

  private bindDrawing(): void {
    let start: { x: number; y: number } | null = null;
    let current: TouchRegion | null = null;
    const point = (event: PointerEvent): { x: number; y: number } => {
      const rect = this.element.getBoundingClientRect();
      const clamp = (value: number): number => Math.min(1, Math.max(0, value));
      return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
    };
    const round = (value: number): number => Math.round(value * 10000) / 10000;
    this.element.addEventListener('pointerdown', (event) => {
      if (!this.drawing) return;
      event.preventDefault();
      this.element.setPointerCapture(event.pointerId);
      start = point(event);
      current = null;
    });
    this.element.addEventListener('pointermove', (event) => {
      if (!this.drawing || !start) return;
      const end = point(event);
      current = {
        x: round(Math.min(start.x, end.x)),
        y: round(Math.min(start.y, end.y)),
        width: round(Math.abs(end.x - start.x)),
        height: round(Math.abs(end.y - start.y)),
      };
      this.renderRegions(current);
    });
    const finish = (): void => {
      if (!this.drawing || !start) return;
      start = null;
      const region = current && current.width > 0.01 && current.height > 0.01 ? current : null;
      if (region) this.drawing(region);
      else this.renderRegions();
    };
    this.element.addEventListener('pointerup', finish);
    this.element.addEventListener('pointercancel', finish);
  }

  private videos(): HTMLVideoElement[] {
    return [this.background, this.character, ...this.layers];
  }

  /** Stop playback and release decoders. */
  destroy(): void {
    this.cancelDrawing();
    this.resizeObserver.disconnect();
    for (const video of this.videos()) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    this.element.remove();
  }
}
