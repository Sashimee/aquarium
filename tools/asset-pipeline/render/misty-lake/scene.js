import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const WIDTH = 4096;
const HEIGHT = 2048;
const HORIZONTAL_FOV_DEG = 54.43; // 35 mm equivalent on a 36 mm wide frame
const verticalFov =
  (2 * Math.atan(Math.tan((HORIZONTAL_FOV_DEG * Math.PI) / 360) * (HEIGHT / WIDTH)) * 180) /
  Math.PI;

const DEPTH_NEAR = 1.5;
const DEPTH_FAR = 14;
const FOCUS_DISTANCE = 3.6;
const FOG_COLOUR = 0x5f9f9a;
const FOG_DENSITY = 0.11;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(617);
const between = (low, high) => low + (high - low) * random();

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.append(renderer.domElement);

const pmrem = new THREE.PMREMGenerator(renderer);
const scene = new THREE.Scene();
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.fog = new THREE.FogExp2(FOG_COLOUR, FOG_DENSITY);

const camera = new THREE.PerspectiveCamera(verticalFov, WIDTH / HEIGHT, 0.1, 40);
camera.position.set(0, 0.5, 3.4);
camera.lookAt(0, 0.62, 0);

scene.add(new THREE.HemisphereLight(0xd6f2ec, 0x2e6a63, 1.5));
const sun = new THREE.DirectionalLight(0xeafff6, 1.3);
sun.position.set(0.6, 6, 2.5);
scene.add(sun);

const ktx2 = new KTX2Loader()
  .setTranscoderPath('/three/examples/jsm/libs/basis/')
  .detectSupport(renderer);
const gltfLoader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
const loadGltf = (file) => gltfLoader.loadAsync(`/assets/${file}`);
const loadTexture = async (file, colorSpace) => {
  const texture = await ktx2.loadAsync(`/assets/${file}`);
  texture.colorSpace = colorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
};

function gradientTexture(stops) {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 512;
  const g = canvas.getContext('2d');
  const gradient = g.createLinearGradient(0, 0, 0, 512);
  for (const [offset, colour] of stops) gradient.addColorStop(offset, colour);
  g.fillStyle = gradient;
  g.fillRect(0, 0, 4, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function blotchMask(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const patchRandom = mulberry32(99);
  for (let i = 0; i < 70; i++) {
    const x = patchRandom() * size;
    const y = size * (0.35 + 0.65 * patchRandom());
    const r = size * (0.04 + 0.12 * patchRandom());
    const radial = g.createRadialGradient(x, y, 0, x, y, r);
    radial.addColorStop(0, 'rgba(255,255,255,0.95)');
    radial.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = radial;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  const front = g.createLinearGradient(0, size * 0.5, 0, size * 0.78);
  front.addColorStop(0, 'rgba(255,255,255,0.1)');
  front.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = front;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

const [fern, vallisneria, pondWeed, driftwood, boulder, rocks] = await Promise.all([
  loadGltf('plant/java-fern/lod0.glb'),
  loadGltf('plant/vallisneria/lod0.glb'),
  loadGltf('plant/pond-weed/lod0.glb'),
  loadGltf('driftwood/dead-quiver-trunk/lod0.glb'),
  loadGltf('rock/boulder-01/lod0.glb'),
  loadGltf('rock/coast-rocks-05/lod0.glb'),
]);
const [sandColour, sandNormal, pebbleColour, pebbleNormal] = await Promise.all([
  loadTexture('substrate/reef-sand/textures/reef-sand_basecolor_2k.ktx2', THREE.SRGBColorSpace),
  loadTexture('substrate/reef-sand/textures/reef-sand_normal_1k.ktx2', THREE.NoColorSpace),
  loadTexture(
    'substrate/clean-pebbles/textures/clean-pebbles_basecolor_2k.ktx2',
    THREE.SRGBColorSpace,
  ),
  loadTexture('substrate/clean-pebbles/textures/clean-pebbles_normal_1k.ktx2', THREE.NoColorSpace),
]);

for (const gltf of [fern, vallisneria, pondWeed]) {
  gltf.scene.traverse((o) => {
    if (o.isMesh) {
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of materials) m.side = THREE.DoubleSide;
    }
  });
}
pondWeed.scene.traverse((o) => {
  if (o.isMesh) {
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) m.color.setScalar(2.4);
  }
});
driftwood.scene.traverse((o) => {
  if (o.isMesh) o.material.color.setScalar(0.55);
});

function place(gltf, { x, y = 0, z, scale, spin = random() * Math.PI * 2, lean = 0, roll = 0 }) {
  const object = gltf.scene.clone(true);
  object.scale.setScalar(scale);
  object.position.set(x, y, z);
  object.rotation.set(lean, spin, roll, 'YXZ');
  scene.add(object);
  return object;
}

const backdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 30),
  new THREE.MeshBasicMaterial({
    map: gradientTexture([
      [0, '#d8efe8'],
      [0.45, '#8fc3bb'],
      [1, '#2c615d'],
    ]),
    fog: false,
  }),
);
backdrop.position.set(0, 3, -13);
scene.add(backdrop);

const floorSize = 40;
const sand = new THREE.Mesh(
  new THREE.PlaneGeometry(floorSize, floorSize),
  new THREE.MeshStandardMaterial({
    map: sandColour,
    normalMap: sandNormal,
    roughness: 0.95,
    color: new THREE.Color(0.5, 0.56, 0.54),
  }),
);
sand.rotation.x = -Math.PI / 2;
sandColour.repeat.set(floorSize / 3, floorSize / 3);
sandNormal.repeat.copy(sandColour.repeat);
scene.add(sand);

const pebbleSpan = 7;
pebbleColour.repeat.set(pebbleSpan / 3, pebbleSpan / 3);
pebbleNormal.repeat.copy(pebbleColour.repeat);
const pebbles = new THREE.Mesh(
  new THREE.PlaneGeometry(pebbleSpan, pebbleSpan),
  new THREE.MeshStandardMaterial({
    map: pebbleColour,
    normalMap: pebbleNormal,
    roughness: 0.8,
    color: new THREE.Color(0.7, 0.75, 0.75),
    transparent: true,
    alphaMap: blotchMask(512),
    depthWrite: false,
  }),
);
pebbles.rotation.x = -Math.PI / 2;
pebbles.position.set(0, 0.004, 0.6);
scene.add(pebbles);

place(driftwood, { x: -1.15, y: 0.02, z: -0.5, scale: 3.2, spin: 0.6, roll: -0.95 });
place(driftwood, { x: -1.7, y: 0.02, z: -1.4, scale: 2.1, spin: 2.2, roll: -0.6 });

place(rocks, { x: 1.15, y: -0.01, z: -0.45, scale: 2.4, spin: 0.4 });
place(boulder, { x: 1.05, y: 0.2, z: -0.5, scale: 1.9, spin: 1.9 });
place(boulder, { x: 1.75, y: -0.01, z: -0.2, scale: 1.3, spin: 4.2 });
place(rocks, { x: 1.75, y: 0.17, z: -0.2, scale: 1.1, spin: 5.1 });

place(fern, { x: -0.55, y: 0.14, z: -0.35, scale: 2.4, lean: 0.12 });
place(fern, { x: -0.9, y: 0.25, z: -0.6, scale: 2.0 });
place(fern, { x: 0.85, y: 0.3, z: -0.4, scale: 2.1 });
place(fern, { x: 0.15, z: -0.9, scale: 2.3 });
place(fern, { x: -1.55, z: 0.15, scale: 1.8 });
place(fern, { x: 1.95, z: 0.4, scale: 2.0 });

function outerness(x) {
  return Math.min(1, Math.max(0, (Math.abs(x) - 0.7) / 0.9));
}

const rows = [
  { z: [-1.6, -2.4], count: 22, spread: 3.4 },
  { z: [-2.6, -4.2], count: 34, spread: 5.4 },
  { z: [-4.4, -6.5], count: 30, spread: 7.5 },
  { z: [-0.9, -1.5], count: 12, spread: 2.9 },
];
for (const row of rows) {
  for (let i = 0; i < row.count; i++) {
    const x = ((i + random() * 0.8) / row.count - 0.5) * 2 * row.spread;
    const z = between(row.z[1], row.z[0]);
    const outer = outerness(x);
    const useWeed = random() < 0.28;
    const scale = useWeed
      ? between(2.6, 3.6) * (0.6 + 0.9 * outer)
      : between(2.4, 3.2) * (0.5 + 1.5 * outer);
    place(useWeed ? pondWeed : vallisneria, { x, z, scale, lean: between(-0.1, 0.1) });
  }
}
for (const x of [-1.95, -1.4, 1.3, 1.9, 2.4, -2.5]) {
  place(pondWeed, { x, z: between(-0.9, -0.2), scale: between(3.2, 4.2) });
}
for (const x of [-0.3, 0.3, -0.05]) {
  place(fern, { x, z: between(-1.4, -1.0), scale: between(1.6, 2.1) });
}

function swapMaterials(toDepth) {
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (toDepth) {
      o.userData.beauty = o.material;
      const source = Array.isArray(o.material) ? o.material[0] : o.material;
      const cutout = source.transparent || source.alphaTest > 0 || source.alphaMap;
      o.material = new THREE.MeshBasicMaterial({
        color: 0x000000,
        map: source.map ?? null,
        alphaMap: source.alphaMap ?? null,
        alphaTest: cutout ? Math.max(0.5, source.alphaTest) : 0,
        side: source.side,
        fog: true,
      });
      if (source.alphaMap) o.material.transparent = true;
    } else if (o.userData.beauty) {
      o.material.dispose();
      o.material = o.userData.beauty;
      delete o.userData.beauty;
    }
  });
}

function capture() {
  return renderer.domElement.toDataURL('image/png');
}

window.renderPasses = () => {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 1);
  renderer.render(scene, camera);
  const beauty = capture();

  const savedFog = scene.fog;
  const savedEnvironment = scene.environment;
  scene.fog = new THREE.Fog(0xffffff, DEPTH_NEAR, DEPTH_FAR);
  scene.environment = null;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  swapMaterials(true);
  backdrop.visible = true;
  renderer.render(scene, camera);
  const depth = capture();
  swapMaterials(false);
  scene.fog = savedFog;
  scene.environment = savedEnvironment;

  return { beauty, depth, near: DEPTH_NEAR, far: DEPTH_FAR, focus: FOCUS_DISTANCE };
};
window.sceneReady = true;
