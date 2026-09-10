/** Types shared by the renderer modules (kept dependency-free on purpose). */

export interface AnimMeta {
  label: string;
  fps: number;
  loop: boolean;
  count: number;
  frames: string[];
}

export interface PetMeta {
  variant: string;
  label: string;
  native: [number, number];
  scale: number;
  anims: Record<string, AnimMeta>;
}

export type Reason =
  | 'idle'
  | 'wake'
  | 'blink'
  | 'sleep'
  | 'walk'
  | 'drag'
  | 'fall'
  | 'land'
  | 'pat'
  | 'angry';

/** One animation channel: a named frame sequence with its own clock. */
export interface Channel {
  /** base animation from the atlas, e.g. "sit" */
  base: string;
  /** transient override, e.g. "pat" -- cleared when it finishes */
  override: string | null;
  /**
   * true while `override` is HELD rather than transient: it keeps looping until
   * releaseOverride() is called (used for the carried pose during a drag).
   */
  persistent?: boolean;
  /** frame index in the active sequence */
  index: number;
  /** seconds accumulated in the current frame */
  elapsed: number;
  /** cycles of the base animation completed (drives blink scheduling) */
  cycles: number;
  /** pending mood, applied on the next base animation change */
  reason: Reason;
}

export interface Vec {
  x: number;
  y: number;
}
