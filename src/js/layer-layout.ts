import type { AdditionalLayer } from './types';

/** Stacking order shared by the badge and the editor preview. */
export function layerZIndex(layer: AdditionalLayer): number {
  return layer.layerPriority === 'foreground' ? 20 + layer.layerOrder : layer.layerOrder;
}

/**
 * Apply a layer's size, alignment and offset as inline styles. Used by the
 * engine and by the editor preview so both place layers identically.
 */
export function applyLayerPlacement(video: HTMLVideoElement, layer: AdditionalLayer): void {
  const style = video.style;
  style.inset = 'auto';
  style.left = 'auto';
  style.right = 'auto';
  style.top = 'auto';
  style.bottom = 'auto';
  style.marginLeft = '0px';
  style.marginTop = '0px';
  style.transform = '';

  const size = layer.size ?? { width: '100%', height: '100%' };
  style.width = size.width;
  style.height = size.height;
  style.objectFit = size.width === 'auto' || size.height === 'auto' ? 'contain' : 'cover';

  const alignment = layer.alignment ?? { horizontal: 'left', vertical: 'top' };
  const posX = layer.position?.x ?? 0;
  const posY = layer.position?.y ?? 0;
  const transforms: string[] = [];

  switch (alignment.horizontal) {
    case 'left':
      style.left = `${posX}px`;
      break;
    case 'center':
      style.left = '50%';
      transforms.push('translateX(-50%)');
      style.marginLeft = `${posX}px`;
      break;
    case 'right':
      style.right = `${posX}px`;
      break;
  }
  switch (alignment.vertical) {
    case 'top':
      style.top = `${posY}px`;
      break;
    case 'center':
      style.top = '50%';
      transforms.push('translateY(-50%)');
      style.marginTop = `${posY}px`;
      break;
    case 'bottom':
      style.bottom = `${posY}px`;
      break;
  }
  style.transform = transforms.join(' ');
}

export interface LayerBox {
  x: number;
  y: number;
  width: number;
  height: number;
  fit: 'contain' | 'cover';
}

function parseDimension(value: string | undefined, stageSize: number): number | null {
  if (!value || value === 'auto') return null;
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return null;
  return value.trim().endsWith('%') ? (number / 100) * stageSize : number;
}

/**
 * The box a layer occupies on a stage of the given size, matching the CSS
 * that applyLayerPlacement produces. Used to draw scene thumbnails on a canvas.
 */
export function computeLayerBox(
  layer: AdditionalLayer,
  stageWidth: number,
  stageHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): LayerBox {
  const size = layer.size ?? { width: '100%', height: '100%' };
  let width = parseDimension(size.width, stageWidth);
  let height = parseDimension(size.height, stageHeight);
  const aspect = naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : 1;
  if (width === null && height === null) { width = naturalWidth; height = naturalHeight; }
  else if (width === null) width = height! * aspect;
  else if (height === null) height = width / aspect;

  const alignment = layer.alignment ?? { horizontal: 'left', vertical: 'top' };
  const posX = layer.position?.x ?? 0;
  const posY = layer.position?.y ?? 0;
  const x = alignment.horizontal === 'left' ? posX
    : alignment.horizontal === 'center' ? (stageWidth - width!) / 2 + posX
      : stageWidth - posX - width!;
  const y = alignment.vertical === 'top' ? posY
    : alignment.vertical === 'center' ? (stageHeight - height!) / 2 + posY
      : stageHeight - posY - height!;

  return {
    x, y, width: width!, height: height!,
    fit: size.width === 'auto' || size.height === 'auto' ? 'contain' : 'cover',
  };
}
