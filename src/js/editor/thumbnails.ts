import type { AdditionalLayer, Scene } from '../types';
import { getCachedBlobUrl } from '../config-loader';
import { computeLayerBox, layerZIndex } from '../layer-layout';

const cache = new Map<string, Promise<string | null>>();

/** Decode one frame of a video, ready to draw on a canvas. */
async function grabFrame(source: string): Promise<HTMLVideoElement | null> {
  try {
    const url = await getCachedBlobUrl(source);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(video.error), { once: true });
    });
    const time = Number.isFinite(video.duration) ? Math.min(0.5, video.duration / 2) : 0;
    if (time > 0) {
      await new Promise<void>((resolve) => {
        video.addEventListener('seeked', () => resolve(), { once: true });
        video.currentTime = time;
      });
    }
    return video;
  } catch {
    return null;
  }
}

function release(video: HTMLVideoElement | null): void {
  if (!video) return;
  video.removeAttribute('src');
  video.load();
}

/** Draw an image into a box using CSS object-fit semantics. */
function drawFitted(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  box: { x: number; y: number; width: number; height: number },
  fit: 'contain' | 'cover',
): void {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return;
  const scale = fit === 'cover'
    ? Math.max(box.width / sourceWidth, box.height / sourceHeight)
    : Math.min(box.width / sourceWidth, box.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  context.save();
  context.beginPath();
  context.rect(box.x, box.y, box.width, box.height);
  context.clip();
  context.drawImage(video, box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height);
  context.restore();
}

async function render(scene: Scene, width: number): Promise<string | null> {
  const stageWidth = Math.max(1, window.innerWidth);
  const stageHeight = Math.max(1, window.innerHeight);
  const scale = width / stageWidth;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(stageHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.scale(scale, scale);
  const full = { x: 0, y: 0, width: stageWidth, height: stageHeight };

  const character = scene.animations.find((animation) => animation.id === scene.defaultAnimation) ?? scene.animations[0];
  const layers = (scene.additionalLayers ?? []).slice().sort((a, b) => layerZIndex(a) - layerZIndex(b));
  const drawLayer = async (layer: AdditionalLayer): Promise<void> => {
    const frame = await grabFrame(layer.source);
    if (!frame) return;
    const box = computeLayerBox(layer, stageWidth, stageHeight, frame.videoWidth, frame.videoHeight);
    drawFitted(context, frame, box, box.fit);
    release(frame);
  };

  // Decode one video at a time to keep memory and decoder use low.
  const background = scene.background?.source ? await grabFrame(scene.background.source) : null;
  if (!background) return null;
  drawFitted(context, background, full, 'cover');
  release(background);
  for (const layer of layers.filter((item) => layerZIndex(item) < 10)) await drawLayer(layer);
  if (character?.source) {
    const frame = await grabFrame(character.source);
    if (frame) { drawFitted(context, frame, full, 'cover'); release(frame); }
  }
  for (const layer of layers.filter((item) => layerZIndex(item) >= 10)) await drawLayer(layer);

  return canvas.toDataURL('image/jpeg', 0.82);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * A still image of the scene as the badge shows it (background, layers and
 * starting animation). Thumbnails are rendered one at a time and cached.
 */
export function sceneThumbnail(scene: Scene, width = 360): Promise<string | null> {
  const character = scene.animations.find((animation) => animation.id === scene.defaultAnimation);
  const key = JSON.stringify([width, scene.background?.source, character?.source, scene.additionalLayers]);
  let result = cache.get(key);
  if (!result) {
    result = queue.then(() => render(scene, width)).catch(() => null);
    queue = result;
    cache.set(key, result);
  }
  return result;
}
