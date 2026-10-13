import type { Sprite, SpriteNodeMaterial } from 'three/webgpu';

/** An instanced sprite draw; `sprite.count` is the instance count. */
export interface SpriteEffect {
  readonly sprite: Sprite;
  readonly material: SpriteNodeMaterial;
}
