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
const DEPTH_FAR = 22;
const FOCUS_DISTANCE = 3.4;

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
const pick = (list) => list[Math.floor(random() * list.length)];

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.append(renderer.domElement);

const pmrem = new THREE.PMREMGenerator(renderer);
const scene = new THREE.Scene();
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.28;

const camera = new THREE.PerspectiveCamera(verticalFov, WIDTH / HEIGHT, 0.1, 60);
camera.position.set(0.1, 0.62, 3.6);
camera.lookAt(0, 0.62, 0);

scene.add(new THREE.HemisphereLight(0xa9dcd8, 0x1d4a48, 0.55));
const sun = new THREE.DirectionalLight(0xf2fff4, 2.4);
sun.position.set(-1.5, 7, 1.5);
scene.add(sun);

function causticTexture(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const image = g.createImageData(size, size);
  const caustic = mulberry32(31);
  const layers = [
    { count: 34, sharp: 26, weight: 1 },
    { count: 70, sharp: 38, weight: 0.45 },
  ].map((layer) => ({
    ...layer,
    points: Array.from({ length: layer.count }, () => [caustic(), caustic()]),
  }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0.1;
      for (const layer of layers) {
        let f1 = Infinity;
        let f2 = Infinity;
        for (const [px, py] of layer.points) {
          let dx = Math.abs(x / size - px);
          let dy = Math.abs(y / size - py);
          if (dx > 0.5) dx = 1 - dx;
          if (dy > 0.5) dy = 1 - dy;
          const d = Math.hypot(dx, dy);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) f2 = d;
        }
        value += layer.weight * Math.exp(-(f2 - f1) * layer.sharp * Math.sqrt(layer.count / 10));
      }
      const v = Math.min(255, Math.round(value * 150));
      const i = (y * size + x) * 4;
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
  }
  g.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const caustics = new THREE.SpotLight(0xe8fff2, 9, 0, 0.62, 0.35, 0);
caustics.position.set(0.4, 7, 1.2);
caustics.target.position.set(0, 0, -1.8);
caustics.map = causticTexture(512);
//BISECT scene.add(caustics, caustics.target);

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

function blotchMask(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const patchRandom = mulberry32(99);
  for (let i = 0; i < 110; i++) {
    const x = patchRandom() * size;
    const y = size * (0.2 + 0.8 * patchRandom());
    const r = size * (0.03 + 0.1 * patchRandom());
    const radial = g.createRadialGradient(x, y, 0, x, y, r);
    radial.addColorStop(0, 'rgba(255,255,255,0.95)');
    radial.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = radial;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  return new THREE.CanvasTexture(canvas);
}

const names = {
  fern: 'plant/java-fern',
  vallisneria: 'plant/vallisneria',
  pondWeed: 'plant/pond-weed',
  staurogyne: 'plant/staurogyne-repens',
  lotus: 'plant/red-tiger-lotus',
};
const plants = {};
for (const [key, dir] of Object.entries(names)) {
  const [near, far] = await Promise.all([loadGltf(`${dir}/lod0.glb`), loadGltf(`${dir}/lod1.glb`)]);
  plants[key] = { near, far };
}
const [driftwood, boulder, rocks] = await Promise.all([
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

const eachMaterial = (gltf, fn) =>
  gltf.scene.traverse((o) => {
    if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) fn(m);
  });
for (const { near, far } of Object.values(plants)) {
  for (const gltf of [near, far]) eachMaterial(gltf, (m) => (m.side = THREE.DoubleSide));
}
for (const gltf of [plants.pondWeed.near, plants.pondWeed.far]) {
  eachMaterial(gltf, (m) => m.color.setScalar(2.2));
}
for (const gltf of [plants.vallisneria.near, plants.vallisneria.far]) {
  eachMaterial(gltf, (m) => m.color.setRGB(0.55, 0.72, 0.5));
}
for (const gltf of [plants.fern.near, plants.fern.far]) {
  eachMaterial(gltf, (m) => m.color.setRGB(0.6, 0.75, 0.55));
}
eachMaterial(driftwood, (m) => m.color.setScalar(0.5));
eachMaterial(boulder, (m) => m.color.setScalar(0.7));
eachMaterial(rocks, (m) => m.color.setScalar(0.7));

function groundHeight(x, z) {
  return (
    0.05 * Math.sin(x * 1.7 + 0.5) * Math.cos(z * 1.3) +
    0.025 * Math.sin(x * 5 + z * 3) +
    0.1 * Math.max(0, -z - 1.2) * 0.35
  );
}

const backdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 40),
  new THREE.MeshBasicMaterial({ color: 0x1a4a4a, fog: false }),
);
backdrop.position.set(0, 3, -19);
scene.add(backdrop);

function groundPlane(size, segments, lift, material) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    position.setY(i, groundHeight(position.getX(i), position.getZ(i)) + lift);
  }
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

sandColour.repeat.set(10, 10);
sandNormal.repeat.copy(sandColour.repeat);
const sand = groundPlane(
  36,
  240,
  0,
  new THREE.MeshStandardMaterial({
    map: sandColour,
    normalMap: sandNormal,
    normalScale: new THREE.Vector2(1.6, 1.6),
    roughness: 0.92,
    color: new THREE.Color(0.55, 0.5, 0.42),
  }),
);
scene.add(sand);

const pebbleSpan = 9;
pebbleColour.repeat.set(pebbleSpan / 1.6, pebbleSpan / 1.6);
pebbleNormal.repeat.copy(pebbleColour.repeat);
const pebbles = groundPlane(
  pebbleSpan,
  90,
  0.006,
  new THREE.MeshStandardMaterial({
    map: pebbleColour,
    normalMap: pebbleNormal,
    normalScale: new THREE.Vector2(1.8, 1.8),
    roughness: 0.7,
    color: new THREE.Color(0.75, 0.72, 0.68),
    transparent: true,
    alphaMap: blotchMask(512),
    depthWrite: false,
  }),
);
pebbles.position.set(0, 0, 0.4);
scene.add(pebbles);

function place(gltf, { x, z, y, scale, spin = random() * Math.PI * 2, lean = 0, roll = 0 }) {
  const object = gltf.scene.clone(true);
  object.scale.setScalar(scale);
  object.position.set(x, y ?? groundHeight(x, z) - 0.01, z);
  object.rotation.set(lean, spin, roll, 'YXZ');
  scene.add(object);
  return object;
}

place(driftwood, {
  x: -1.1,
  z: -0.7,
  y: groundHeight(-1.1, -0.7) + 0.13,
  scale: 3.6,
  spin: 0.35,
  roll: -1.38,
});
place(driftwood, {
  x: -1.9,
  z: -1.6,
  y: groundHeight(-1.9, -1.6) + 0.1,
  scale: 2.7,
  spin: 2.4,
  roll: 1.42,
});
place(driftwood, {
  x: 0.4,
  z: -2.4,
  y: groundHeight(0.4, -2.4) + 0.1,
  scale: 2.4,
  spin: 5.2,
  roll: -1.35,
});

place(rocks, { x: 1.35, z: -0.6, scale: 2.6, spin: 0.4 });
place(boulder, { x: 1.25, z: -0.65, y: groundHeight(1.25, -0.65) + 0.19, scale: 2.0, spin: 1.9 });
place(boulder, { x: 2.0, z: -0.3, scale: 1.4, spin: 4.2 });
place(rocks, { x: 2.0, z: -0.3, y: groundHeight(2, -0.3) + 0.17, scale: 1.15, spin: 5.1 });
place(boulder, { x: -0.4, z: -2.0, scale: 1.7, spin: 3.3 });
place(rocks, { x: 0.9, z: 1.0, scale: 0.7, spin: 1.0 });
place(boulder, { x: -1.7, z: 0.9, scale: 0.6, spin: 2.0 });
place(rocks, { x: 0.1, z: 1.4, scale: 0.45, spin: 4.0 });

const outerness = (x) => Math.min(1, Math.max(0, (Math.abs(x) - 0.6) / 1.0));
const kinds = ['fern', 'vallisneria', 'vallisneria', 'pondWeed', 'staurogyne', 'lotus'];

function cluster(row) {
  const kind = row.kinds ? pick(row.kinds) : pick(kinds);
  const cx = between(-row.spread, row.spread);
  const cz = between(row.z[1], row.z[0]);
  const count = Math.round(between(row.perCluster[0], row.perCluster[1]));
  const outer = outerness(cx);
  for (let i = 0; i < count; i++) {
    const x = cx + between(-0.35, 0.35);
    const z = cz + between(-0.3, 0.3);
    const heightBias = 0.45 + 1.15 * outerness(x);
    const scale =
      between(row.scale[0], row.scale[1]) * heightBias * (kind === 'pondWeed' ? 1.3 : 1);
    const lod = z < -1.5 ? plants[kind].far : plants[kind].near;
    place(lod, { x, z, scale, lean: between(-0.14, 0.14), roll: between(-0.08, 0.08) });
  }
  return outer;
}

const rows = [
  {
    z: [-0.3, -1.0],
    spread: 2.4,
    clusters: 7,
    perCluster: [1, 3],
    scale: [1.0, 1.7],
    kinds: ['fern', 'staurogyne', 'lotus', 'pondWeed'],
  },
  { z: [-1.0, -2.0], spread: 2.9, clusters: 12, perCluster: [2, 4], scale: [1.6, 2.6] },
  { z: [-2.0, -3.2], spread: 3.6, clusters: 14, perCluster: [3, 5], scale: [2.0, 3.0] },
  { z: [-3.2, -5.0], spread: 4.8, clusters: 16, perCluster: [3, 6], scale: [2.4, 3.6] },
  { z: [-5.0, -8.0], spread: 7.0, clusters: 18, perCluster: [3, 6], scale: [2.8, 4.2] },
  { z: [-8.0, -12.0], spread: 10.0, clusters: 14, perCluster: [3, 6], scale: [3.2, 4.8] },
];
for (const row of rows) for (let i = 0; i < row.clusters; i++) cluster(row);

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

const capture = () => renderer.domElement.toDataURL('image/png');

window.renderPasses = () => {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 1);
  renderer.render(scene, camera);
  const beauty = capture();

  const savedEnvironment = scene.environment;
  scene.fog = new THREE.Fog(0xffffff, DEPTH_NEAR, DEPTH_FAR);
  scene.environment = null;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  swapMaterials(true);
  renderer.render(scene, camera);
  const depth = capture();
  swapMaterials(false);
  scene.fog = null;
  scene.environment = savedEnvironment;

  return { beauty, depth, near: DEPTH_NEAR, far: DEPTH_FAR, focus: FOCUS_DISTANCE };
};
window.sceneReady = true;
