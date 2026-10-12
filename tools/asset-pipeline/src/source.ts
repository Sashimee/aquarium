import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  Accessor,
  Document,
  NodeIO,
  type Mesh,
  type Node,
  type Primitive,
} from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { transformMesh } from '@gltf-transform/functions';
import { IDENTITY, multiply, type Mat4 } from './math.ts';

export function homeDir(): string {
  const home = process.env['HOME'];
  if (!home)
    throw new Error('HOME is not set; the raw assets live in $HOME/.cache/aquarium-assets/raw');
  return home;
}

export const RAW_ROOT = join(homeDir(), '.cache', 'aquarium-assets', 'raw');

interface GltfJson {
  images?: { uri?: string }[];
  buffers?: { uri?: string }[];
}

/** Rejects a glTF whose image or buffer URIs point outside the asset's own raw directory. */
export function assertSelfContainedGltf(gltfPath: string, rawDir: string): void {
  const json = JSON.parse(readFileSync(gltfPath, 'utf8')) as GltfJson;
  const base = realpathSync(rawDir);
  const gltfDir = resolve(gltfPath, '..');
  const uris = [...(json.images ?? []), ...(json.buffers ?? [])]
    .map((entry) => entry.uri)
    .filter((uri): uri is string => typeof uri === 'string' && !uri.startsWith('data:'));
  for (const uri of uris) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(uri);
    } catch {
      throw new Error(`${gltfPath}: URI "${uri}" is not valid percent-encoding`);
    }
    if (
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded) ||
      isAbsolute(decoded) ||
      /^[/\\]/.test(decoded)
    ) {
      throw new Error(`${gltfPath}: URI "${uri}" is absolute or has a scheme; refusing to read it`);
    }
    if (decoded.split(/[/\\]/).includes('..')) {
      throw new Error(`${gltfPath}: URI "${uri}" contains ".."; refusing to read it`);
    }
    const target = resolve(gltfDir, decoded);
    const real = existsSync(target) ? realpathSync(target) : target;
    const rel = relative(base, real);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`${gltfPath}: URI "${uri}" resolves outside ${rawDir}`);
    }
  }
}

export async function readGltf(sourceId: string, relativePath: string): Promise<Document> {
  const rawDir = join(RAW_ROOT, sourceId);
  const path = join(rawDir, relativePath);
  assertSelfContainedGltf(path, rawDir);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  return io.read(path);
}

export interface ManifestSource {
  id: string;
  sha256: string | null;
  files?: { path: string; sha256: string }[] | undefined;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Checks the raw files of a source against the manifest hashes; throws on any mismatch or missing file. */
export function verifyRawSource(
  source: ManifestSource,
  aggregate: (files: { path: string; sha256: string }[]) => string,
  rawRoot: string = RAW_ROOT,
): void {
  const dir = join(rawRoot, source.id);
  if (!existsSync(dir)) throw new Error(`${source.id}: ${dir} is missing; download it first`);
  if (source.sha256 === null)
    throw new Error(`${source.id}: manifest has no sha256 (still pending download)`);
  if (source.files) {
    for (const file of source.files) {
      const path = join(dir, file.path);
      if (!existsSync(path)) throw new Error(`${source.id}: ${file.path} is missing from ${dir}`);
      if (sha256File(path) !== file.sha256) {
        throw new Error(
          `${source.id}: ${file.path} does not match the manifest sha256; re-download it`,
        );
      }
    }
    if (aggregate(source.files) !== source.sha256) {
      throw new Error(`${source.id}: manifest files[] do not add up to its aggregate sha256`);
    }
    return;
  }
  const present = readdirSync(dir);
  if (present.length !== 1) {
    throw new Error(
      `${source.id}: manifest has no files[], so ${dir} must hold exactly one file (found ${present.length})`,
    );
  }
  if (sha256File(join(dir, present[0]!)) !== source.sha256) {
    throw new Error(
      `${source.id}: ${present[0]} does not match the manifest sha256; re-download it`,
    );
  }
}

function mat4FromAccessor(accessor: Accessor, index: number): Mat4 {
  const m: number[] = [];
  accessor.getElement(index, m);
  return m;
}

function skinMatrices(node: Node): Mat4[] {
  const skin = node.getSkin();
  if (!skin) return [];
  const ibm = skin.getInverseBindMatrices();
  const joints = skin.listJoints();
  return joints.map((joint, i) => {
    const inverseBind = ibm ? mat4FromAccessor(ibm, i) : IDENTITY;
    return multiply(joint.getWorldMatrix(), inverseBind);
  });
}

function bakeSkinnedPrimitive(prim: Primitive, matrices: Mat4[]): void {
  const position = prim.getAttribute('POSITION');
  const normal = prim.getAttribute('NORMAL');
  const joints = prim.getAttribute('JOINTS_0');
  const weights = prim.getAttribute('WEIGHTS_0');
  if (!position || !joints || !weights) return;
  const p = [0, 0, 0];
  const n = [0, 0, 0];
  const j: number[] = [0, 0, 0, 0];
  const w: number[] = [0, 0, 0, 0];
  const outP: number[] = [0, 0, 0];
  const outN: number[] = [0, 0, 0];
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, p);
    if (normal) normal.getElement(i, n);
    joints.getElement(i, j);
    weights.getElement(i, w);
    outP[0] = outP[1] = outP[2] = 0;
    outN[0] = outN[1] = outN[2] = 0;
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const weight = w[k]!;
      if (weight === 0) continue;
      const m = matrices[j[k]!]!;
      total += weight;
      outP[0]! += weight * (m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!);
      outP[1]! += weight * (m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!);
      outP[2]! += weight * (m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!);
      outN[0]! += weight * (m[0]! * n[0]! + m[4]! * n[1]! + m[8]! * n[2]!);
      outN[1]! += weight * (m[1]! * n[0]! + m[5]! * n[1]! + m[9]! * n[2]!);
      outN[2]! += weight * (m[2]! * n[0]! + m[6]! * n[1]! + m[10]! * n[2]!);
    }
    if (total === 0) {
      outP[0] = p[0]!;
      outP[1] = p[1]!;
      outP[2] = p[2]!;
      outN[0] = n[0]!;
      outN[1] = n[1]!;
      outN[2] = n[2]!;
    } else {
      outP[0]! /= total;
      outP[1]! /= total;
      outP[2]! /= total;
    }
    position.setElement(i, outP);
    if (normal) {
      const len = Math.hypot(outN[0]!, outN[1]!, outN[2]!) || 1;
      normal.setElement(i, [outN[0]! / len, outN[1]! / len, outN[2]! / len]);
    }
  }
  prim.setAttribute('JOINTS_0', null);
  prim.setAttribute('WEIGHTS_0', null);
}

function isolateMesh(node: Node): Mesh {
  const mesh = node.getMesh()!;
  const users = mesh.listParents().filter((p) => p.propertyType === 'Node');
  if (users.length <= 1) return mesh;
  const copy = mesh.clone();
  node.setMesh(copy);
  return copy;
}

export type SkinPose = 'bind' | 'rest';

/**
 * Bakes every mesh node into world space: skinned meshes are either skinned once with the node-tree rest pose ('rest') or kept in their bind pose ('bind'), then skins,
 * animations, joints and hierarchy are dropped. Some exports park joints away from the bind pose
 * until the first animation frame, so 'bind' is the safe default.
 */
export function bakeToWorldSpace(
  doc: Document,
  dropMesh: (name: string) => boolean,
  skinPose: SkinPose = 'bind',
): void {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('source has no scene');
  const meshNodes = root.listNodes().filter((n) => n.getMesh());

  for (const node of meshNodes) {
    const mesh = node.getMesh()!;
    if (dropMesh(mesh.getName()) || dropMesh(node.getName())) {
      node.setMesh(null);
      continue;
    }
    const target = isolateMesh(node);
    if (node.getSkin()) {
      if (skinPose === 'rest') {
        const matrices = skinMatrices(node);
        for (const prim of target.listPrimitives()) bakeSkinnedPrimitive(prim, matrices);
      } else {
        for (const prim of target.listPrimitives()) {
          prim.setAttribute('JOINTS_0', null);
          prim.setAttribute('WEIGHTS_0', null);
        }
      }
      node.setSkin(null);
    } else {
      transformMesh(target, node.getWorldMatrix());
    }
  }

  for (const mesh of root.listMeshes()) {
    if (!mesh.listParents().some((parent) => parent.propertyType === 'Node')) mesh.dispose();
  }
  for (const animation of root.listAnimations()) animation.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  for (const camera of root.listCameras()) camera.dispose();

  const keep = meshNodes.filter((n) => n.getMesh());
  for (const node of root.listNodes()) {
    if (!keep.includes(node)) node.dispose();
  }
  for (const child of scene.listChildren()) scene.removeChild(child);
  for (const node of keep) {
    node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    scene.addChild(node);
  }
}
