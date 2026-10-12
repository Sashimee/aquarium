import type { Node } from 'three/webgpu';

// The runtime (NodeManager.getFogNode, AnalyticLightNode) reads these, but @types/three 0.186 omits them.
declare module 'three/src/scenes/Scene.js' {
  interface Scene {
    fogNode?: Node | null;
  }
}

declare module 'three/src/lights/Light.js' {
  interface Light {
    colorNode?: Node | null;
  }
}
