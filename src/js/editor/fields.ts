import { h, icon } from './dom';

let fieldCounter = 0;
const nextId = (): string => `ed-field-${++fieldCounter}`;

export interface Option<T extends string = string> {
  value: T;
  label: string;
}

/** A labelled form row. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const target = control.matches('input, select, textarea') ? control : control.querySelector<HTMLElement>('input, select, textarea');
  const id = target?.id || nextId();
  if (target && !target.id) target.id = id;
  return h('div', { class: 'ed-field' },
    h('label', { class: 'ed-label', for: target ? id : undefined }, label),
    control,
    hint ? h('p', { class: 'ed-hint' }, hint) : null,
  );
}

export function textInput(value: string, onChange: (value: string) => void, options: { placeholder?: string; maxLength?: number; commitOnBlur?: boolean; type?: string } = {}): HTMLInputElement {
  const input = h('input', { class: 'ed-input', type: options.type ?? 'text', placeholder: options.placeholder, maxLength: options.maxLength });
  input.value = value;
  input.addEventListener(options.commitOnBlur ? 'change' : 'input', () => onChange(input.value));
  return input;
}

export function numberInput(value: number | undefined, onChange: (value: number) => void, options: { min?: number; max?: number; step?: number; suffix?: string; placeholder?: string } = {}): HTMLElement {
  const input = h('input', { class: 'ed-input', type: 'number', inputMode: 'decimal', min: options.min, max: options.max, step: options.step ?? 'any', placeholder: options.placeholder });
  input.value = value === undefined || Number.isNaN(value) ? '' : String(value);
  input.addEventListener('input', () => {
    if (input.value === '') return;
    const number = Number(input.value);
    if (Number.isFinite(number)) onChange(number);
  });
  if (!options.suffix) return input;
  return h('div', { class: 'ed-affix' }, input, h('span', null, options.suffix));
}

const toSeconds = (ms: number | undefined): number | undefined => ms === undefined ? undefined : Math.round(ms / 100) / 10;

/** A time stored in milliseconds, edited in seconds. */
export function secondsInput(ms: number | undefined, onChange: (ms: number) => void): HTMLElement {
  return numberInput(toSeconds(ms), (seconds) => onChange(Math.round(seconds * 1000)), { min: 0, suffix: 's' });
}

/** "between [a] and [b] seconds" for a { min, max } range stored in milliseconds. */
export function secondsRange(range: { min: number; max: number }, onChange: () => void): HTMLElement {
  return h('div', { class: 'ed-range' },
    secondsInput(range.min, (value) => { range.min = value; onChange(); }),
    h('span', { class: 'ed-range-sep' }, 'to'),
    secondsInput(range.max, (value) => { range.max = value; onChange(); }),
  );
}

export function select<T extends string>(options: Option<T>[], value: T, onChange: (value: T) => void): HTMLSelectElement {
  const element = h('select', { class: 'ed-input ed-select' }, options.map((option) => h('option', { value: option.value }, option.label)));
  element.value = value;
  element.addEventListener('change', () => onChange(element.value as T));
  return element;
}

export function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void, hint?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', class: 'ed-switch-input', role: 'switch' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'ed-switch' },
    input,
    h('span', { class: 'ed-switch-track', 'aria-hidden': 'true' }),
    h('span', { class: 'ed-switch-text' }, h('span', null, label), hint ? h('small', null, hint) : null),
  );
}

export function segmented<T extends string>(options: Option<T>[], value: T, onChange: (value: T) => void, ariaLabel?: string): HTMLElement {
  const group = h('div', { class: 'ed-segmented', role: 'radiogroup', 'aria-label': ariaLabel });
  const buttons = options.map((option) => {
    const button = h('button', { type: 'button', role: 'radio', class: 'ed-segment' }, option.label);
    button.setAttribute('aria-checked', String(option.value === value));
    button.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-checked', String(other === button));
      onChange(option.value);
    });
    return button;
  });
  group.append(...buttons);
  return group;
}

export function button(label: string, onClick: (event: MouseEvent) => void, options: { variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; icon?: string; title?: string; small?: boolean } = {}): HTMLButtonElement {
  const classes = ['ed-button', `ed-button-${options.variant ?? 'subtle'}`];
  if (options.small) classes.push('ed-button-small');
  if (!label) classes.push('ed-button-icon');
  return h('button', { type: 'button', class: classes.join(' '), title: options.title, 'aria-label': options.title, onclick: onClick },
    options.icon ? icon(options.icon) : null,
    label ? h('span', null, label) : null,
  );
}

export function sectionHeader(title: string, description?: string, ...actions: HTMLElement[]): HTMLElement {
  return h('div', { class: 'ed-section-header' },
    h('div', null, h('h3', null, title), description ? h('p', null, description) : null),
    actions.length ? h('div', { class: 'ed-section-actions' }, actions) : null,
  );
}

export function emptyState(message: string): HTMLElement {
  return h('p', { class: 'ed-empty' }, message);
}

export interface VideoPickerOptions {
  source: string | undefined;
  label: string;
  describe: (source: string | undefined) => string;
  upload: (file: File) => Promise<string>;
  onChange: (source: string | undefined) => void;
  onPreview?: () => void;
  optional?: boolean;
}

/** Shows the chosen video with buttons to preview, replace or remove it. */
export function videoPicker(options: VideoPickerOptions): HTMLElement {
  let source = options.source;
  const name = h('span', { class: 'ed-video-name' });
  const status = h('span', { class: 'ed-video-status' });
  const fileInput = h('input', { type: 'file', accept: 'video/*,.webm,.mp4,.mov', class: 'ed-hidden-file' });
  const preview = options.onPreview ? button('', () => options.onPreview?.(), { icon: 'eye', title: `Preview ${options.label.toLowerCase()}`, small: true }) : null;
  const remove = options.optional ? button('', () => { source = undefined; options.onChange(undefined); refresh(); }, { icon: 'trash', title: `Remove ${options.label.toLowerCase()}`, small: true, variant: 'ghost' }) : null;
  const choose = h('label', { class: 'ed-button ed-button-subtle ed-button-small' }, icon('upload'), h('span', null, 'Choose'), fileInput);

  const refresh = (): void => {
    name.textContent = source ? options.describe(source) : 'No video chosen';
    root.classList.toggle('is-empty', !source);
    if (preview) preview.hidden = !source;
    if (remove) remove.hidden = !source;
    (choose.querySelector('span') as HTMLElement).textContent = source ? 'Replace' : 'Choose';
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    status.textContent = 'Uploading…';
    try {
      source = await options.upload(file);
      status.textContent = '';
      options.onChange(source);
      refresh();
      options.onPreview?.();
    } catch (error) {
      status.textContent = `Could not use this file: ${(error as Error).message}`;
    }
  });

  const root = h('div', { class: 'ed-video' },
    h('span', { class: 'ed-video-icon' }, icon('film')),
    h('span', { class: 'ed-video-text' }, name, status),
    h('span', { class: 'ed-video-actions' }, preview, choose, remove),
  );
  refresh();
  return root;
}

/** A collapsible card used for animations, layers and moods. */
export function itemCard(options: {
  key: string;
  title: string;
  meta?: (string | HTMLElement)[];
  open: boolean;
  onToggle: (open: boolean) => void;
  onSelect?: () => void;
  selected?: boolean;
  body: () => HTMLElement[];
}): HTMLElement {
  const details = h('details', { class: `ed-item${options.selected ? ' is-selected' : ''}`, dataset: { key: options.key } });
  details.open = options.open;
  const summary = h('summary', { class: 'ed-item-summary' },
    h('span', { class: 'ed-item-chevron' }, icon('chevron')),
    h('span', { class: 'ed-item-title' }, options.title),
    h('span', { class: 'ed-item-meta' }, (options.meta ?? []).map((meta) => typeof meta === 'string' ? h('span', { class: 'ed-chip' }, meta) : meta)),
  );
  const body = h('div', { class: 'ed-item-body' });
  let built = false;
  const build = (): void => {
    if (built) return;
    built = true;
    body.append(...options.body());
  };
  if (details.open) build();
  details.addEventListener('toggle', () => {
    if (details.open) build();
    options.onToggle(details.open);
  });
  summary.addEventListener('click', () => options.onSelect?.());
  details.append(summary, body);
  return details;
}
