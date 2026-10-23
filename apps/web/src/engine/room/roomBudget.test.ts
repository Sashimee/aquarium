import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOM_IDS, type RoomId } from '@aquarium/shared';
import { planRoomScene, type RoomScenePlan } from '../../scene/room/roomScene';
import { ROOM_CUBE_SIZE } from '../environment';
import { TIERS, type Tier } from '../quality/tiers';
import { TANK_DIMENSIONS } from '../tank/dimensions';
import { roomAssetsFrom, roomTierFor } from './RoomStage';

const PUBLIC_ASSETS = join(__dirname, '../../../public/assets');
const MIB = 2 ** 20;
const KHR_DF_MODEL_ETC1S = 163;
const KHR_DF_MODEL_UASTC = 166;

const indexJson: unknown = JSON.parse(readFileSync(join(PUBLIC_ASSETS, 'index.json'), 'utf8'));
const assets = roomAssetsFrom(indexJson);

/** A 1k equirectangular HDRI, 1024x512, as BC6H on desktop or rewrapped RGBA16F where BC6H is missing. */
const HDRI_BYTES = { bc6h: 1024 * 512, rgba16f: 1024 * 512 * 8 } as const;
/** The room PMREM, a 3x4-face RGBA16F target. */
const PMREM_BYTES = 3 * ROOM_CUBE_SIZE * 4 * ROOM_CUBE_SIZE * 8;
/** PMREMGenerator's ping-pong target, the PMREM's size, which lives only while an HDRI is drawn. */
const PING_PONG_BYTES = PMREM_BYTES;
const MOBILE_ROOM_BYTES = 8_000_000;

type DecodeTarget = 'etc' | 'bc';

function ktx2Bytes(file: string, target: DecodeTarget): number {
  const bytes = readFileSync(join(PUBLIC_ASSETS, file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];
  if (!magic.every((b, i) => bytes[i] === b)) throw new Error(`${file} is not a KTX2 file`);
  const width = view.getUint32(20, true);
  const height = Math.max(1, view.getUint32(24, true));
  const faces = view.getUint32(36, true);
  const levels = Math.max(1, view.getUint32(40, true));
  const dfd = view.getUint32(48, true);
  const colorModel = view.getUint8(dfd + 4 + 8);
  const samples = (view.getUint16(dfd + 4 + 6, true) - 24) / 16;
  let blockBytes: number;
  if (colorModel === KHR_DF_MODEL_ETC1S) blockBytes = target === 'etc' && samples === 1 ? 8 : 16;
  else if (colorModel === KHR_DF_MODEL_UASTC) blockBytes = 16;
  else throw new Error(`${file}: colour model ${colorModel} is not a Basis texture`);
  let total = 0;
  for (let level = 0; level < levels; level++) {
    const w = Math.max(1, width >> level);
    const h = Math.max(1, height >> level);
    total += Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes;
  }
  return total * faces;
}

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

interface GlbUse {
  /** Decoded vertex and index bytes: meshopt-compressed buffers are counted as uploaded. */
  readonly geometry: number;
  /** Textures relative to the assets root. */
  readonly textures: readonly string[];
}

function glbUse(file: string): GlbUse {
  const glb = readFileSync(join(PUBLIC_ASSETS, file));
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a binary glTF`);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as {
    accessors: { count: number; componentType: number; type: string }[];
    images?: { uri?: string }[];
  };
  let geometry = 0;
  for (const accessor of json.accessors) {
    const size = COMPONENT_BYTES[accessor.componentType];
    const components = TYPE_COMPONENTS[accessor.type];
    if (!size || !components) throw new Error(`${file}: unexpected accessor ${accessor.type}`);
    geometry += accessor.count * size * components;
  }
  const textures = (json.images ?? []).map((image, i) => {
    if (image.uri === undefined) throw new Error(`${file}: image ${i} is embedded, not KTX2`);
    return posix.normalize(posix.join(posix.dirname(file), image.uri));
  });
  return { geometry, textures };
}

interface RoomCost {
  readonly draws: number;
  readonly triangles: number;
  readonly geometry: number;
  readonly textures: number;
  readonly hdri: number;
  /** Shell, furniture and the HDRI download held together, the most the room ever holds. */
  readonly total: number;
  /**
   * What drawing the HDRI briefly adds: the HDRI and the ping-pong target. RoomStage frees the last
   * room before and loads the furniture only after, so the furniture is never resident with it.
   */
  readonly drawing: number;
}

function roomCost(roomId: RoomId, tier: Tier, mobile: boolean): RoomCost {
  const roomTier = roomTierFor(tier, mobile);
  const plan: RoomScenePlan = planRoomScene({
    roomId,
    tank: TANK_DIMENSIONS.standard,
    tier: roomTier,
    catalog: assets.catalog,
  });
  let geometry = 0;
  const files = new Set<string>();
  for (const prop of plan.props) {
    const use = glbUse(assets.files(prop.asset, prop.lod));
    geometry += use.geometry;
    for (const texture of use.textures) files.add(texture);
  }
  let textures = 0;
  for (const file of files) textures += ktx2Bytes(file, mobile ? 'etc' : 'bc');
  const hdri = assets.hdriUrl(roomId) === null ? 0 : mobile ? HDRI_BYTES.rgba16f : HDRI_BYTES.bc6h;
  return {
    draws: plan.drawCalls,
    triangles: plan.triangles,
    geometry,
    textures,
    hdri,
    total: geometry + textures + hdri,
    drawing: hdri === 0 ? 0 : hdri + PING_PONG_BYTES,
  };
}

const mib = (bytes: number) => (bytes / MIB).toFixed(2);

describe('room GPU budget', () => {
  it('counts the engine PMREM baseline every room shares', () => {
    expect(PMREM_BYTES / MIB).toBe(6);
  });

  it('keeps a phone within 8 MB, with the HDRI as RGBA16F, in every room at any tier', () => {
    for (const tier of TIERS) {
      for (const roomId of ROOM_IDS) {
        const cost = roomCost(roomId, tier, true);
        expect(cost.total, `${roomId} ${tier}`).toBeLessThanOrEqual(MOBILE_ROOM_BYTES);
      }
    }
  });

  it('peaks at about 10 MiB on a phone only while an HDRI is drawn, with no furniture loaded', () => {
    for (const roomId of ROOM_IDS) {
      const cost = roomCost(roomId, 'ultra', true);
      expect(cost.drawing / MIB, roomId).toBeCloseTo(10, 5);
      expect(cost.drawing, roomId).toBeLessThanOrEqual(MOBILE_ROOM_BYTES + cost.hdri);
    }
  });

  it('keeps a desktop within 24 MB in every room at any tier', () => {
    for (const tier of TIERS) {
      for (const roomId of ROOM_IDS) {
        const cost = roomCost(roomId, tier, false);
        expect(cost.total / MIB, `${roomId} ${tier}`).toBeLessThanOrEqual(24);
      }
    }
  });

  it('reports the cost of each room per tier', () => {
    const rows: string[] = [];
    for (const [label, mobile] of [
      ['desktop', false],
      ['phone', true],
    ] as const) {
      for (const tier of TIERS) {
        const costs = ROOM_IDS.map((id) => roomCost(id, tier, mobile));
        const worst = (pick: (c: RoomCost) => number) => Math.max(...costs.map(pick));
        rows.push(
          `${label} ${tier}: draws ≤${worst((c) => c.draws)}, tris ≤${worst((c) => c.triangles)}, ` +
            `geometry ≤${mib(worst((c) => c.geometry))} MiB, textures ≤${mib(worst((c) => c.textures))} MiB, ` +
            `total ≤${mib(worst((c) => c.total))} MiB, ` +
            `drawing an HDRI ≤${mib(worst((c) => c.drawing))} MiB`,
        );
      }
    }
    if (process.env.ROOM_BUDGET_REPORT) console.info(rows.join('\n'));
    expect(rows).toHaveLength(2 * TIERS.length);
  });
});
