import type { LoadedAnim, SpriteAtlas } from './atlas';
import type { Channel, Reason } from './types';

/** A transient animation that returns to the base when it finishes. */
const TRANSIENT: Record<string, Reason | undefined> = {
  pat: 'pat',
  angry: 'angry',
  carry: 'drag',
  land: 'land',
};

/**
 * Owns the animation clock: which sequence is playing, which frame within it,
 * and when a transient reaction has finished so the pet can settle back down.
 *
 * Deliberately free of drawing and physics so it can be unit-reasoned about.
 */
export class Animator {
  ch: Channel = { base: 'sit', override: null, index: 0, elapsed: 0, cycles: 0, reason: 'idle' };
  private warned = new Set<string>();

  constructor(private readonly atlas: SpriteAtlas) {}

  /** the sequence currently on screen */
  active(): LoadedAnim {
    const key = this.ch.override ?? this.ch.base;
    const anim = this.atlas.anims.get(key);
    if (anim) return anim;
    if (!this.warned.has(key)) {
      this.warned.add(key);
      console.warn(`[anim] 缺少动画 "${key}"，回退到 sit`);
    }
    return this.atlas.anims.get('sit')!;
  }

  /** switch the base animation; ignored when a transient is playing */
  setBase(key: string): void {
    if (this.ch.base === key) return;
    if (!this.atlas.anims.has(key)) return;
    if (this.ch.override) {
      this.ch.base = key;         // takes effect when the transient ends
      return;
    }
    this.ch.base = key;
    this.ch.index = 0;
    this.ch.elapsed = 0;
  }

  /** play a one-shot reaction now */
  playTransient(key: string): void {
    if (!this.atlas.anims.has(key)) return;
    // never interrupt a HELD pose: an idle blink firing mid-drag used to replace
    // the "carried" pose with a blink, so the cat appeared to be set down
    if (this.ch.persistent && this.ch.override !== key) return;
    if (this.ch.override === key) {
      this.ch.index = 0;
      this.ch.elapsed = 0;
      return;
    }
    this.ch.override = key;
    this.ch.index = 0;
    this.ch.elapsed = 0;
    this.ch.persistent = false;
  }

  /**
   * Hold a pose until it is released, looping it for as long as it lasts.
   *
   * Used while the user drags the cat: the "held up by the scruff" animation has
   * to stay up for the whole drag, however long that is. A transient cannot do
   * that -- it hands control back to the base animation as soon as its frames run
   * out (0.3s for a short loop), so the cat would drop back to sitting while
   * still being carried.
   */
  holdOverride(key: string): void {
    if (!this.atlas.anims.has(key)) return;
    if (this.ch.override === key && this.ch.persistent) return;
    this.ch.override = key;
    this.ch.index = 0;
    this.ch.elapsed = 0;
    this.ch.persistent = true;
  }

  /** release a held pose and return to the base animation */
  releaseOverride(): void {
    if (!this.ch.override || !this.ch.persistent) return;
    this.ch.override = null;
    this.ch.index = 0;
    this.ch.elapsed = 0;
    this.ch.persistent = false;
    this.ch.reason = 'drag';
  }

  get isTransient(): boolean {
    return this.ch.override !== null;
  }

  /** true while a pose is held (a drag), which nothing else may interrupt */
  get isHeld(): boolean {
    return this.ch.persistent === true;
  }

  /** advance the clock; returns the animation that should be drawn */
  update(dt: number, paused: boolean): LoadedAnim {
    const anim = this.active();
    if (paused) return anim;

    const fps = Math.max(0.1, anim.fps);
    this.ch.elapsed += dt;
    const step = 1 / fps;
    while (this.ch.elapsed >= step) {
      this.ch.elapsed -= step;
      this.ch.index += 1;
      if (this.ch.index >= anim.frames.length) {
        if (this.ch.override && !this.ch.persistent) {
          // transient finished -> hand control back to the base animation
          const tr = this.ch.override;
          this.ch.override = null;
          this.ch.index = 0;
          this.ch.elapsed = 0;
          this.ch.reason = TRANSIENT[tr] ?? 'idle';
        } else if (this.ch.override) {
          // a held pose keeps looping until it is released
          this.ch.index = 0;
          this.ch.cycles += 1;
        } else if (anim.loop) {
          this.ch.index = 0;
          this.ch.cycles += 1;
        } else {
          this.ch.index = anim.frames.length - 1;
          this.ch.elapsed = 0;
          break;
        }
      }
    }
    return this.active();
  }

  currentFrame(): HTMLImageElement {
    const anim = this.active();
    const idx = Math.min(this.ch.index, anim.frames.length - 1);
    return anim.frames[Math.max(0, idx)].img;
  }
}
