export interface TouchRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TriggerCounter {
  id: string;
  increment: number;
}

export interface InteractionTrigger {
  type: 'touch' | 'random' | 'rub';
  region?: TouchRegion;
  timeRange?: { min: number; max: number };
  duration?: number;
  waitForCompletion: boolean;
  loopWhileActive?: boolean;
  triggerCounter?: TriggerCounter;
}

export interface MoodAnimationOverride {
  animation: string;
  speed?: number;
  source?: string;
}

export interface Mood {
  id: string;
  setAnimations?: MoodAnimationOverride[];
  interactionTriggers?: InteractionTrigger[];
}

export interface TransitionSource {
  source: string;
  loop?: boolean;
  loopCount?: number;
}

export interface Animation {
  id: string;
  source: string;
  loop: boolean;
  loopCount?: number;
  entryTransition?: string | TransitionSource;
  exitTransition?: string | TransitionSource;
  setsMood?: string;
  interactionTriggers?: InteractionTrigger[];
}

export interface Background {
  source: string;
  loop: boolean;
}

export interface LayerAlignment {
  horizontal: 'left' | 'center' | 'right';
  vertical: 'top' | 'center' | 'bottom';
}

export interface LayerSize {
  width: string;  // e.g. "100%", "200px", "auto"
  height: string; // e.g. "100%", "200px", "auto"
}

export interface AdditionalLayer {
  id?: string;
  source: string;
  loop: boolean;
  layerOrder: number;
  layerPriority: 'background' | 'foreground';
  position?: { x: number; y: number };
  alignment?: LayerAlignment;
  size?: LayerSize;
  interactionTriggers?: InteractionTrigger[];
  targetAnimation?: string;
}

export interface SceneDuration {
  min: number;
  max: number;
}

export interface Scene {
  id: string;
  background: Background;
  entryAnimation?: TransitionSource;
  exitAnimation?: TransitionSource;
  sceneDuration?: SceneDuration;
  additionalLayers?: AdditionalLayer[];
  defaultAnimation: string;
  defaultMood?: string;
  moods?: Mood[];
  animations: Animation[];
}

export interface AnimationConfigSettings {
  defaultScene?: string;
}

export interface AnimationConfig {
  settings?: AnimationConfigSettings;
  scenes: Scene[];
}
