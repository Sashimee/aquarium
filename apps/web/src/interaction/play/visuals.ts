import {
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';
import type { FoodType } from '@aquarium/shared';
import type { Vec3 } from '../camera';
import { FOOD_PROFILES } from '../food/profiles';
import { FOOD_PARTICLES } from '@aquarium/sim';
import { FoodField, MAX_FOOD_PARTICLES } from '../food/particles';
import { BubbleField, MAX_BUBBLES } from './bubbles';
import { NoriLayer } from './nori';
import { MAX_RIPPLES, RippleField } from './ripples';

const FOOD_COLORS: Readonly<Record<FoodType, number>> = {
  flakes: 0xc8742a,
  pellets: 0x8a5a2b,
  bloodworms: 0x8c1d1d,
  'brine-shrimp': 0xe3a98a,
  nori: 0x0d1c12,
  'algae-wafer': 0x3d4a22,
};

const FADE_TAIL_S = 12;
const LASER_RADIUS_M = 0.006;
const Z_AXIS = new Vector3(0, 0, 1);

/** Everything the play layer draws: food, bubbles, glass ripples and the laser dot. */
export class PlayVisuals {
  readonly group = new Group();
  private readonly food: InstancedMesh;
  private readonly nori: NoriLayer;
  private readonly bubbles: InstancedMesh;
  private readonly rings: Mesh<RingGeometry, MeshBasicNodeMaterial>[] = [];
  private readonly laser: Mesh;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly matrix = new Matrix4();
  private readonly pos = new Vector3();
  private readonly quat = new Quaternion();
  private readonly scale = new Vector3();
  private readonly color = new Color();
  private readonly normal = new Vector3();
  private readonly sway = { dx: 0, dz: 0 };

  constructor() {
    const foodGeometry = new SphereGeometry(1, 8, 6);
    const foodMaterial = new MeshStandardNodeMaterial({ roughness: 0.85 });
    this.food = new InstancedMesh(foodGeometry, foodMaterial, MAX_FOOD_PARTICLES);
    this.food.count = 0;
    this.food.frustumCulled = false;
    this.nori = new NoriLayer(MAX_FOOD_PARTICLES);

    const bubbleGeometry = new SphereGeometry(1, 10, 8);
    const bubbleMaterial = new MeshStandardNodeMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      roughness: 0.05,
      depthWrite: false,
    });
    this.bubbles = new InstancedMesh(bubbleGeometry, bubbleMaterial, MAX_BUBBLES);
    this.bubbles.count = 0;
    this.bubbles.frustumCulled = false;

    const ringGeometry = new RingGeometry(0.92, 1, 48);
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const material = new MeshBasicNodeMaterial({
        color: 0xcfeaff,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      });
      const ring = new Mesh(ringGeometry, material);
      ring.visible = false;
      this.rings.push(ring);
      this.group.add(ring);
      this.disposables.push(material);
    }

    const laserMaterial = new MeshBasicNodeMaterial({ color: 0xff2a2a, toneMapped: false });
    this.laser = new Mesh(new SphereGeometry(LASER_RADIUS_M, 12, 8), laserMaterial);
    this.laser.visible = false;
    this.laser.renderOrder = 10;

    this.group.add(this.food, this.nori.mesh, this.bubbles, this.laser);
    this.disposables.push(
      foodGeometry,
      foodMaterial,
      bubbleGeometry,
      bubbleMaterial,
      ringGeometry,
      this.laser.geometry,
      laserMaterial,
    );
  }

  setLaser(point: Vec3 | null): void {
    this.laser.visible = point !== null;
    if (point) this.laser.position.set(point.x, point.y, point.z);
  }

  update(food: FoodField, bubbles: BubbleField, ripples: RippleField): void {
    this.drawFood(food);
    this.drawBubbles(bubbles);
    this.drawRipples(ripples);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.food.dispose();
    this.nori.dispose();
    this.bubbles.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private drawFood(field: FoodField): void {
    const list = field.particles;
    let beads = 0;
    let sheets = 0;
    this.quat.identity();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      const profile = FOOD_PROFILES[p.food];
      const remaining =
        p.settledS < 0 ? 1 : Math.min(1, Math.max(0, (profile.decayS - p.settledS) / FADE_TAIL_S));
      if (p.food === 'nori') {
        this.nori.set(sheets++, {
          id: p.id,
          x: p.x,
          y: p.y,
          z: p.z,
          eaten: p.eaten / FOOD_PARTICLES.nori.portion,
        });
        continue;
      }
      const r = profile.radius * remaining;
      this.pos.set(p.x, p.y + r * 0.5, p.z);
      this.scale.set(r, r * 0.7, r);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.food.setMatrixAt(beads, this.matrix);
      this.food.setColorAt(beads, this.color.setHex(FOOD_COLORS[p.food]));
      beads++;
    }
    this.food.count = beads;
    this.food.instanceMatrix.needsUpdate = true;
    if (this.food.instanceColor) this.food.instanceColor.needsUpdate = true;
    this.nori.commit(sheets);
  }

  private drawBubbles(field: BubbleField): void {
    const list = field.bubbles;
    this.bubbles.count = list.length;
    this.quat.identity();
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b) continue;
      BubbleField.wobble(b, this.sway);
      this.pos.set(b.x + this.sway.dx, b.y, b.z + this.sway.dz);
      this.scale.set(b.radius, b.radius, b.radius);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.bubbles.setMatrixAt(i, this.matrix);
    }
    this.bubbles.instanceMatrix.needsUpdate = true;
  }

  private drawRipples(field: RippleField): void {
    const list = field.ripples;
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i];
      if (!ring) continue;
      const r = list[i];
      ring.visible = r !== undefined;
      if (!r) continue;
      const radius = RippleField.radius(r);
      ring.position.set(r.origin.x, r.origin.y, r.origin.z);
      this.normal.set(r.normal.x, r.normal.y, r.normal.z);
      ring.quaternion.setFromUnitVectors(Z_AXIS, this.normal);
      ring.scale.set(radius, radius, 1);
      ring.material.opacity = RippleField.opacity(r);
    }
  }
}
