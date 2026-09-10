import type { PetMode, PetScale, RoamSpeed } from '../config-types';
import type { SpriteAtlas } from './atlas';
import type { Animator } from './animator';

/**
 * How fast the cat walks in roam mode, in px/s, one entry per menu preset.
 *
 * Kept here (not in main) so the renderer owns everything about motion: main
 * only stores and forwards the chosen preset. 'normal' is the speed the mode
 * shipped with.
 */
export const ROAM_SPEED_PX: Record<RoamSpeed, number> = {
  slow: 55,
  normal: 115,
  fast: 210,
};

/** fall physics + behaviour tuning, all in work-area pixels */
export const TUNING = {
  gravity: 2000,        // px/s^2 while falling
  maxFall: 2400,
  restitution: 0.22,    // bounce on landing
  /** wander: idle time at a target before choosing the next one */
  roamRestMinMs: 500,
  roamRestMaxMs: 1600,
  followSpeed: 230,     // px/s while chasing the cursor
  /** follow: settle when this close to the cursor */
  followArrive: 26,
  squashMs: 260,
  blinkEveryMs: 5200,   // average gap between idle blinks
  sleepAfterMs: 26_000, // sit still this long -> doze off
  mouseIdleMs: 90_000,  // no pointer movement for this long -> stop following
};

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Owns where the pet is and how it moves.
 *
 * POSITION MODEL (read this before touching the code):
 * `x` and `y` are WORK-AREA (world) coordinates of the sprite's BOTTOM-CENTRE --
 * the point where the cat's feet are. `y` may sit anywhere between the top of the
 * work area and the ground line, so the pet is free to occupy the whole screen.
 *
 * This replaced an older model where `y` was pinned to the ground line and a
 * separate `hover` lift moved the sprite upwards only. That model could not
 * express "the pet is lower on screen than the ground line", which broke both
 * follow mode (the cat stopped above the bottom of the screen) and roam mode
 * (the cat could only ever walk along the bottom edge). The old `hover` remains
 * as a derived read-only value so diagnostics and traces keep their shape.
 *
 * Gravity is NOT the default state: it only runs while the pet is falling
 * (`vy != 0` outside follow/roam), i.e. after a drag is released or after
 * switching out of follow mode mid-air. Follow moves the pet freely in two
 * dimensions; roam wanders in two dimensions and hops where it needs height.
 */
export class PetController {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /**
   * Which way the cat faces. `1` = facing RIGHT, `-1` = facing LEFT.
   *
   * The artwork is drawn facing LEFT (its tail sits on the right: measured lower
   * half centre-of-mass 257.7px versus the head's 209.5px on a 456px-wide frame),
   * so the renderer mirrors it when facing right. Getting this backwards is
   * exactly the "walks right while looking left" bug users reported.
   */
  facing: 1 | -1 = 1;
  onGround = true;
  paused = false;
  /** true while follow mode is walking at the cursor (drives the walk anim) */
  chasing = false;

  /**
   * How fast the cat walks in roam mode. A preset, not a pixel value: main owns
   * the menu, this class owns the numbers (see ROAM_SPEED_PX).
   */
  roamSpeed: RoamSpeed = 'normal';

  /** current squash amount, 0..1, decaying after a landing */
  private squash = 0;
  private squashLeft = 0;
  private dragDx = 0;
  private lastDx = 0;
  private wasDragging = false;

  /** current wander destination (roam mode), in world coordinates */
  private roamTarget: { x: number; y: number } | null = null;
  private roamRestLeft = 0;
  /** alternates the wander destination between high ground and the floor */
  private roamHigh = false;

  constructor(
    private readonly atlas: SpriteAtlas,
    private readonly anim: Animator,
    private area: WorkArea,
    public scale: PetScale,
    mode: PetMode,
    roamSpeed: RoamSpeed = 'normal',
  ) {
    this._mode = mode;
    this.roamSpeed = roamSpeed;
  }

  private _mode: PetMode;

  get mode(): PetMode {
    return this._mode;
  }

  set mode(next: PetMode) {
    if (this._mode === next) return;
    this._mode = next;
    // never leave a wander destination behind for the next visit
    this.roamTarget = null;
    this.roamRestLeft = 0;
    this.chasing = false;
    this.vx = 0;
    this.vy = 0;
    this.onGround = this.y >= this.groundY - 0.5;
    if (next === 'follow') {
      // follow drives the position directly; no fall physics in the way
      this.onGround = false;
    }
  }

  /** the sprite's bottom edge in world coordinates */
  get drawY(): number {
    return this.y;
  }

  /**
   * Derived, read-only: how far the sprite sits above the ground line (may be
   * negative). Kept so diagnostics, traces and probes keep reporting the same
   * quantities they always did.
   */
  get hover(): number {
    return this.groundY - this.y;
  }

  /** the sprite's bottom-centre on screen, which is what the pointer must hit */
  get visualX(): number {
    return this.x;
  }

  get visualY(): number {
    return this.y;
  }

  get spriteW(): number {
    return this.atlas.width * this.scale;
  }

  get spriteH(): number {
    return this.atlas.height * this.scale;
  }

  get groundY(): number {
    return this.area.y + this.area.height;
  }

  /** visual squash factor applied on top of the scale while drawing */
  get squashFactor(): number {
    return this.squash;
  }

  /** live wander state, published in diagnostics so roam can be inspected */
  get wanderDebug(): Record<string, unknown> {
    return {
      target: this.roamTarget
        ? { x: Math.round(this.roamTarget.x), y: Math.round(this.roamTarget.y) }
        : null,
      restLeft: Math.round(this.roamRestLeft * 1000) / 1000,
      vy: Math.round(this.vy),
      onGround: this.onGround,
      y: Math.round(this.y),
    };
  }

  setArea(area: WorkArea): void {
    this.area = area;
    this.clampToArea();
    this.onGround = this.y >= this.groundY - 0.6;
  }

  setScale(scale: PetScale): void {
    if (this.scale === scale) return;
    const wasGround = this.onGround;
    this.scale = scale;
    if (wasGround) this.y = this.groundY;
    this.clampToArea();
  }

  placeDefault(edge: 'br' | 'center' = 'br'): void {
    this.y = this.groundY;
    this.onGround = true;
    this.x = edge === 'br'
      ? this.area.x + this.area.width - this.spriteW * 0.72
      : this.area.x + this.area.width / 2;
    this.vx = 0;
    this.vy = 0;
  }

  restore(x: number, y: number, facing: 1 | -1): void {
    this.x = x;
    this.y = y;
    this.facing = facing;
    this.clampToArea();
    this.onGround = Math.abs(this.y - this.groundY) < 1;
    this.vx = 0;
    this.vy = 0;
  }

  // -- interactions ------------------------------------------------------

  startDrag(): void {
    this.vx = 0;
    this.vy = 0;
    this.chasing = false;
    this.roamTarget = null;
    // Held for as long as the drag lasts: as a transient the pose expired after
    // ~0.3s and the cat dropped back to sitting while still being carried.
    this.anim.holdOverride('carry');
  }

  /**
   * Move the sprite so its bottom-centre sits at (x, y) in world coordinates.
   *
   * The drag hook and the pointer handlers all speak this same space now: the
   * pet once kept its feet pinned to the ground line and expressed the drag as a
   * "lift", so dragging DOWN was swallowed by the lift clamp and the cat moved
   * the wrong way. `y` is the position; there is nothing left to convert.
   */
  dragTo(x: number, y: number): void {
    // face the way the cat is being pulled: dragging right must not leave it
    // looking left (the movement modes set facing from their own direction, but
    // a drag bypasses all of them)
    const moved = x - this.x;
    if (Math.abs(moved) > 1.5) this.facing = moved > 0 ? 1 : -1;
    this.x = clamp(x, this.area.x + this.spriteW / 2, this.area.x + this.area.width - this.spriteW / 2);
    this.y = clamp(y, this.area.y + this.spriteH, this.groundY);
    this.onGround = this.y >= this.groundY - 0.5;
  }

  endDrag(): void {
    // put the cat down: hand the animation back before gravity takes over
    this.anim.releaseOverride();
    // release momentum from the last drag delta, then fall to the ground
    this.vx = clamp(this.lastDx * 18, -900, 900);
    this.vy = 0;
    this.onGround = this.y >= this.groundY - 0.5;
  }

  /** called on pointer release; small movement means it was a pet, not a drag */
  pat(): void {
    this.anim.setBase('sit');
    this.anim.playTransient('pat');
  }

  anger(): void {
    this.anim.setBase('sit');
    this.anim.playTransient('angry');
  }

  wake(): void {
    this.anim.setBase('sit');
    this.anim.playTransient('blink');
  }

  // -- per-frame ---------------------------------------------------------

  update(
    dt: number,
    opts: { dragging: boolean; pointer: { x: number; y: number }; pointerIdleMs: number; roamSpeed: RoamSpeed },
  ): void {
    // a preset change takes effect on the next frame; nothing else to rewire
    this.roamSpeed = opts.roamSpeed;
    const prevX = this.x;

    if (!this.paused) {
      if (opts.dragging) {
        // position is driven by dragTo()
        this.dragDx = this.x - prevX;
      } else {
        // a drag that just ended leaves the pet in the air: gravity takes it
        if (this.wasDragging) this.onGround = this.y >= this.groundY - 0.5;

        const wasChasing = this.chasing;
        this.chasing = false;

        if (this.mode === 'follow') {
          // follow walks straight at the cursor, anywhere in the work area
          this.chase(dt, opts.pointer);
        } else if (this.mode === 'roam') {
          this.wander(dt);
        } else if (!this.onGround) {
          this.fall(dt);
        } else {
          this.vx = 0;
          // NOTE: rest mode deliberately keeps the idle pose chosen by the
          // renderer (sit / blink / sleep); it must not force `walk` here.
          void wasChasing;
        }

        this.enforceEdges();
      }

      if (this.squashLeft > 0) {
        this.squashLeft -= dt;
        this.squash = Math.max(0, this.squash * (this.squashLeft / (TUNING.squashMs / 1000)));
      }
    }

    this.wasDragging = opts.dragging;
    this.lastDx = this.dragDx;
    this.dragDx = 0;
  }

  // -- movement modes ----------------------------------------------------

  /**
   * Follow: walk in a straight line to the cursor, in TWO dimensions.
   *
   * The aim point is the sprite's CENTRE, clamped to the work area. Aiming the
   * feet at the cursor used to be wrong in the opposite way: a cursor near the
   * bottom of the screen asked for a position below the legal range, the clamp
   * pinned the pet, and the cat appeared unable to follow downwards at all.
   */
  private chase(dt: number, pointer: { x: number; y: number }): void {
    const targetX = clamp(
      pointer.x,
      this.area.x + this.spriteW / 2,
      this.area.x + this.area.width - this.spriteW / 2,
    );
    // the sprite's bottom must stay inside the area: [area.y + spriteH, groundY]
    const targetY = clamp(
      pointer.y + this.spriteH / 2,
      this.area.y + this.spriteH,
      this.groundY,
    );
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= TUNING.followArrive) {
      this.chasing = false;
      if (!this.anim.isTransient) this.anim.setBase('sit');
      return;
    }

    this.chasing = true;
    if (!this.anim.isTransient) this.anim.setBase('walk');

    const speed = Math.min(TUNING.followSpeed, dist * 6);
    const step = (speed * dt) / dist;
    this.x += dx * step;
    this.y += dy * step;
    this.onGround = this.y >= this.groundY - 0.5;
    if (Math.abs(dx) > 2) this.facing = dx < 0 ? -1 : 1;   // -1 = facing left
    this.clampToArea();
  }

  /**
   * Roam: walk in a straight line to a random spot anywhere in the work area.
   *
   * No jumping and no gravity here (user decision, session 8): the cat picks a
   * random destination, walks there in a straight diagonal line at `roamSpeed`,
   * settles for a moment, then picks the next one. This replaced a chained-hop
   * implementation that was far more code and far less predictable.
   */
  private wander(dt: number): void {
    // pick a new destination after a short pause
    if (!this.roamTarget) {
      if (this.roamRestLeft > 0) {
        this.roamRestLeft -= dt;
        this.vx = 0;
        this.vy = 0;
        if (this.roamRestLeft <= 0) this.chooseRoamTarget();
        return;
      }
      this.chooseRoamTarget();
    }

    const t = this.roamTarget;
    if (!t) return;

    const dx = t.x - this.x;
    const dy = t.y - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= 3) {
      // arrived: settle, then choose somewhere else
      this.roamTarget = null;
      this.roamRestLeft = (TUNING.roamRestMinMs + Math.random() * (TUNING.roamRestMaxMs - TUNING.roamRestMinMs)) / 1000;
      this.vx = 0;
      this.vy = 0;
      this.onGround = this.y >= this.groundY - 0.5;
      return;
    }

    // a straight line towards the destination, in both axes at once
    const speed = ROAM_SPEED_PX[this.roamSpeed];
    const step = Math.min(dist, speed * dt) / dist;
    this.x += dx * step;
    this.y += dy * step;
    this.vx = dx > 0 ? speed : -speed;
    this.vy = dy > 0 ? speed : -speed;
    if (Math.abs(dx) > 2) this.facing = dx > 0 ? 1 : -1;
    // walking between two points in the air is intentional here, not a fall
    this.onGround = this.y >= this.groundY - 0.5;

    this.clampToArea();
  }

  /**
   * Destination for the next wander leg: anywhere in the work area.
   *
   * The full legal band is used, so the cat crosses the whole screen instead of
   * pacing along the bottom. Heights alternate between the upper part of the
   * screen and the floor: uniform sampling put most destinations near the floor
   * and made vertical coverage a lottery (measured: 1/8 to 8/8 height slices
   * across 34s windows).
   */
  private chooseRoamTarget(): void {
    const w = this.spriteW;
    const lo = this.area.x + w * 0.6;
    const hi = this.area.x + this.area.width - w * 0.6;
    const span = Math.max(0, hi - lo);
    const top = this.area.y + this.spriteH;                  // highest legal bottom edge
    const usable = Math.max(0, this.area.height - this.spriteH);
    this.roamHigh = !this.roamHigh;
    // high legs land in the top ~40% of the band, low legs in the rest
    const y = this.roamHigh
      ? top + Math.random() * usable * 0.4
      : top + usable * (0.5 + Math.random() * 0.5);
    this.roamTarget = { x: lo + Math.random() * span, y };
    this.onGround = this.y >= this.groundY - 0.5;
  }

  /** free fall with a bounce, used after a drag and after leaving follow */
  private fall(dt: number): void {
    this.vy = Math.min(TUNING.maxFall, this.vy + TUNING.gravity * dt);
    this.y += this.vy * dt;
    this.x += this.vx * dt;
    this.vx *= 0.995;
    if (this.y >= this.groundY && this.vy > 0) this.land(this.vy);
  }

  /** shared landing: squash, and a brief shake when the impact was hard */
  private land(impact: number): void {
    this.y = this.groundY;
    this.onGround = true;
    const speed = Math.abs(impact);
    if (speed > 260) {
      this.squash = clamp(speed / 2600, 0.12, 0.5);
      this.squashLeft = TUNING.squashMs / 1000;
      this.anim.setBase('sit');
      // NOTE: there is no `land` frame set -- playTransient('land') was a silent
      // no-op and the fall looked completely flat. `angry` is the two-frame
      // "hiss" pose and reads as a hard landing.
      this.anim.playTransient('angry');
    }
    this.vy = 0;
    this.vx = 0;
  }

  private enforceEdges(): void {
    const minX = this.area.x + this.spriteW * 0.2;
    const maxX = this.area.x + this.area.width - this.spriteW * 0.2;
    if (this.x < minX) {
      this.x = minX;
      this.vx = Math.abs(this.vx);
      this.facing = 1;
    } else if (this.x > maxX) {
      this.x = maxX;
      this.vx = -Math.abs(this.vx);
      this.facing = -1;
    }
  }

  /** the sprite must stay inside the work area, at every scale */
  private clampToArea(): void {
    const halfW = this.spriteW / 2;
    this.x = clamp(this.x, this.area.x + halfW, this.area.x + this.area.width - halfW);
    this.y = clamp(this.y, this.area.y + this.spriteH, this.groundY);
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
