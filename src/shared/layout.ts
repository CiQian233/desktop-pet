/**
 * Window layout shared by main and renderer.
 *
 * The pet window is a full-work-area transparent overlay. Every surface is
 * click-through except the pet's own pixels, so the desktop underneath stays
 * fully usable.
 */

/** native sprite size (px) -- must match assets/sprites/pet.json */
export const SPRITE_W = 72;
export const SPRITE_H = 68;

/** where the sprite art sits inside the window, as a fraction of the sprite box */
export const PET_BOX = { x: 0, y: 0, w: SPRITE_W, h: SPRITE_H };

/** keep this much transparent margin around the drawn pet when reporting the
 *  interactive rectangle, so a 1px jitter at the edge does not cause flicker */
export const HIT_PAD = 2;

export interface HitBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function petHitBox(anchorX: number, anchorY: number, scale: number, facing: 1 | -1): HitBox {
  const w = SPRITE_W * scale;
  const h = SPRITE_H * scale;
  // anchor is the sprite's bottom-centre (the cat's feet)
  return {
    x: anchorX - w / 2 - HIT_PAD,
    y: anchorY - h - HIT_PAD,
    w: w + HIT_PAD * 2,
    h: h + HIT_PAD * 2,
  };
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampAnchor(
  anchorX: number,
  anchorY: number,
  scale: number,
  area: WorkArea,
): { x: number; y: number } {
  const half = (SPRITE_W * scale) / 2;
  const h = SPRITE_H * scale;
  return {
    x: Math.max(area.x + half * 0.4, Math.min(area.x + area.width - half * 0.4, anchorX)),
    y: Math.max(area.y + h * 0.5, Math.min(area.y + area.height, anchorY)),
  };
}

export const IPC = {
  /** renderer -> main: pet moved, update the click-through region */
  hitBox: 'pet:hitbox',
  /** renderer -> main: toggle interactive / click-through */
  interactive: 'pet:interactive',
  /** renderer -> main: persist a config patch */
  patchConfig: 'config:patch',
  /** main -> renderer: config changed (tray menu, second instance, ...) */
  configChanged: 'config:changed',
  /** renderer -> main: open the tray/context menu at the cursor */
  openMenu: 'app:openMenu',
  /** renderer -> main: quit */
  quit: 'app:quit',
  /** renderer -> main: request current config at boot */
  ready: 'app:ready',
} as const;
