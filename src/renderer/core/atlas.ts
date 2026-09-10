import type { AnimMeta, PetMeta } from './types';

export interface Frame {
  img: HTMLImageElement;
  w: number;
  h: number;
}

export interface LoadedAnim extends Omit<AnimMeta, 'frames'> {
  /** decoded frames, replacing the meta's relative URLs */
  frames: Frame[];
  /** true when the sequence should play while the pet sits still */
  isIdle: boolean;
}

/**
 * Loads every frame up-front and exposes per-animation frame sequences.
 *
 * All frames share the sprite's native size, so the atlas reports one size for
 * everything -- which is what the hit box and the physics ground contact need.
 */
export class SpriteAtlas {
  readonly anims = new Map<string, LoadedAnim>();
  width = 0;
  height = 0;

  static async load(metaUrl: string): Promise<SpriteAtlas> {
    const res = await fetch(metaUrl);
    if (!res.ok) throw new Error(`无法读取 ${metaUrl} (HTTP ${res.status})`);
    const meta = (await res.json()) as PetMeta;
    const atlas = new SpriteAtlas();
    atlas.width = meta.native[0];
    atlas.height = meta.native[1];

    const base = metaUrl.replace(/[^/]*$/, '');
    for (const [key, anim] of Object.entries(meta.anims)) {
      const frames = await Promise.all(anim.frames.map((rel) => loadFrame(base + rel)));
      atlas.anims.set(key, { ...anim, frames, isIdle: IDLE_FOR.has(key) });
    }
    return atlas;
  }

  /** animations that a resting pet cycles through on its own */
  idleAnims(): string[] {
    return [...this.anims.entries()].filter(([, a]) => a.isIdle).map(([k]) => k);
  }
}

/** keys that belong to the "sitting around being alive" set */
const IDLE_FOR = new Set(['sit', 'blink', 'sleep']);

function loadFrame(src: string): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ img, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error(`帧加载失败: ${src}`));
    img.src = src;
  });
}
