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

declare module 'three/src/nodes/core/NodeBuilder.js' {
  export default interface NodeBuilder {
    /** True while a velocity attachment needs previous-frame positions (TRAA). */
    needsPreviousData(): boolean;
  }
}
