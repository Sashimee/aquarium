import type { LightShadow, Node, NodeFrame, RenderTarget } from 'three/webgpu';

// The runtime (NodeManager.getFogNode/getEnvironmentNode, AnalyticLightNode) reads these, but @types/three 0.186 omits them.
declare module 'three/src/scenes/Scene.js' {
  interface Scene {
    fogNode?: Node | null;
    environmentNode?: Node | null;
  }
}

declare module 'three/src/lights/Light.js' {
  interface Light {
    colorNode?: Node | null;
  }
}

// AnalyticLightNode.setupShadow uses `shadow.shadowNode` in place of its own ShadowNode.
declare module 'three/src/lights/LightShadow.js' {
  interface LightShadow {
    shadowNode?: Node;
  }
}

declare module 'three/src/nodes/lighting/ShadowNode.js' {
  export default interface ShadowNode {
    readonly shadow: LightShadow;
    readonly shadowMap: RenderTarget;
    /** Called by `updateShadow` with the shadow map bound as the render target. */
    renderShadow(frame: NodeFrame): void;
  }
}

declare module 'three/src/nodes/core/NodeBuilder.js' {
  export default interface NodeBuilder {
    /** True while a velocity attachment needs previous-frame positions (TRAA). */
    needsPreviousData(): boolean;
  }
}
