import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdditiveBlending,
  AgXToneMapping,
  Box3,
  CustomBlending,
  MaterialBlending,
  MeshBasicNodeMaterial,
  MultiplyBlending,
  NoBlending,
  Node as NodeClass,
  NormalBlending,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  SRGBColorSpace,
  SubtractiveBlending,
  type Blending,
  type Node,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { PhotoLook } from '../photo/look';
import {
  blendsVelocity,
  needsPost,
  PostPipeline,
  type PostNodeName,
  type PostNodes,
  postSettingsKey,
  type PostSettings,
  temporalOutputs,
} from './post';
import { Caustics } from '../water/caustics';
import { WaterMedium } from '../water/medium';
import { WaterShafts } from './shafts';

describe('blendsVelocity', () => {
  function material(transparent: boolean, blending: Blending): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ transparent });
    m.blending = blending;
    return m;
  }

  it.each([
    NormalBlending,
    AdditiveBlending,
    SubtractiveBlending,
    MultiplyBlending,
    CustomBlending,
  ])('is true for a transparent material blending with mode %s', (blending) => {
    expect(blendsVelocity(material(true, blending))).toBe(true);
  });

  it('is false for an opaque material, which writes its own velocity', () => {
    expect(blendsVelocity(material(false, NormalBlending))).toBe(false);
  });

  it.each([AdditiveBlending, SubtractiveBlending, MultiplyBlending, CustomBlending])(
    'is true for an opaque material blending with mode %s, which three blends anyway',
    (blending) => {
      expect(blendsVelocity(material(false, blending))).toBe(true);
    },
  );

  it('is false for a transparent material that does not blend, and so overwrites', () => {
    expect(blendsVelocity(material(true, NoBlending))).toBe(false);
  });
});

describe('temporalOutputs', () => {
  it('blends the velocity attachment as each material blends, like the colour', () => {
    const outputs = temporalOutputs();
    expect(outputs.getBlendMode('velocity').blending).toBe(MaterialBlending);
    expect(outputs.getBlendMode('output').blending).toBe(MaterialBlending);
    expect(Object.keys(outputs.outputNodes)).toEqual(['output', 'velocity']);
  });
});

describe('photo post settings', () => {
  const plain: PostSettings = {
    chain: 'none',
    godRays: false,
    depthOfField: false,
    photo: null,
    grade: false,
  };

  it('needs a post pass for the photo grade alone, even with no chain', () => {
    expect(needsPost(plain)).toBe(false);
    expect(needsPost({ ...plain, photo: new PhotoLook(), grade: true })).toBe(true);
  });

  it('goes straight to the canvas in photo mode when nothing grades or blurs', () => {
    expect(needsPost({ ...plain, photo: new PhotoLook() })).toBe(false);
    expect(needsPost({ ...plain, photo: new PhotoLook(), depthOfField: true })).toBe(true);
  });

  it('keys a pipeline by whether it grades, not by which look, which lives in uniforms', () => {
    const graded = postSettingsKey({ ...plain, photo: new PhotoLook(), grade: true });
    expect(graded).not.toBe(postSettingsKey(plain));
    expect(postSettingsKey({ ...plain, photo: new PhotoLook(), grade: true })).toBe(graded);
  });

  it('keys the photo lens only where depth of field uses it', () => {
    const smaa: PostSettings = { ...plain, chain: 'smaa' };
    expect(postSettingsKey({ ...smaa, photo: new PhotoLook() })).toBe(postSettingsKey(smaa));
    const blurred: PostSettings = { ...smaa, depthOfField: true };
    expect(postSettingsKey({ ...blurred, photo: new PhotoLook() })).not.toBe(
      postSettingsKey(blurred),
    );
  });
});

describe('PostPipeline disposal', () => {
  const renderer = {
    toneMapping: AgXToneMapping,
    outputColorSpace: SRGBColorSpace,
  } as unknown as WebGPURenderer;
  const loaded: PostNodes = { bloom, dof, smaa, traa };
  const nodes = { get: <K extends PostNodeName>(name: K): PostNodes[K] => loaded[name] };
  const shafts = {} as unknown as WaterShafts;

  // SMAA decodes its lookup tables through an <img>, which Node lacks.
  beforeEach(() => {
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        onload: (() => void) | null = null;
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Every render target the graph under `root` holds, its nodes' private ones included. */
  function renderTargets(root: Node): Set<RenderTarget> {
    const seen = new Set<Node>();
    const targets = new Set<RenderTarget>();
    const collect = (value: unknown): void => {
      if (value instanceof RenderTarget) targets.add(value);
      else if (Array.isArray(value)) for (const item of value) collect(item);
      else if (value instanceof NodeClass) visit(value);
    };
    const visit = (node: Node): void => {
      if (seen.has(node)) return;
      seen.add(node);
      for (const value of Object.values(node)) collect(value);
      for (const child of node.getChildren()) visit(child);
    };
    visit(root);
    return targets;
  }

  const chains = ['none', 'smaa', 'smaa-bloom', 'taa-bloom'] as const;
  const cases = chains.flatMap((chain) =>
    [false, true].flatMap((depthOfField) =>
      [false, true].map((grade) => ({ chain, depthOfField, grade })),
    ),
  );

  it.each(cases)(
    'frees every render target it made: $chain, dof $depthOfField, grade $grade',
    ({ chain, depthOfField, grade }) => {
      const camera = new PerspectiveCamera(40, 16 / 9, 0.05, 50);
      const settings: PostSettings = {
        chain,
        godRays: false,
        depthOfField,
        photo: grade ? new PhotoLook() : null,
        grade,
      };
      const pipeline = new PostPipeline(renderer, nodes, new Scene(), camera, shafts, settings);
      const targets = renderTargets(pipeline.outputNode);
      expect(targets.size).toBeGreaterThan(0);
      const disposed = new Set<RenderTarget>();
      for (const target of targets) {
        target.addEventListener('dispose', () => disposed.add(target));
      }

      pipeline.dispose();
      expect([...targets].filter((target) => !disposed.has(target))).toEqual([]);
    },
  );

  describe('light shafts', () => {
    function waterShafts(): WaterShafts {
      const box = new Box3(new Vector3(-0.5, 0, -0.2), new Vector3(0.5, 0.5, 0.2));
      const medium = new WaterMedium(box, { cdom440: 0, turbidity: 0.1 });
      return new WaterShafts(new PerspectiveCamera(), medium, new Caustics(medium));
    }

    function build(chain: PostSettings['chain'], water: WaterShafts): PostPipeline {
      const settings: PostSettings = {
        chain,
        godRays: true,
        depthOfField: false,
        photo: null,
        grade: false,
      };
      const camera = new PerspectiveCamera(40, 16 / 9, 0.05, 50);
      return new PostPipeline(renderer, nodes, new Scene(), camera, water, settings);
    }

    it.each(['none', 'smaa', 'smaa-bloom'] as const)(
      'denoises the march jitter without a temporal resolve: %s (#1542)',
      (chain) => {
        const water = waterShafts();
        const denoise = vi.spyOn(water, 'denoise');
        build(chain, water).dispose();
        expect(denoise).toHaveBeenCalledTimes(1);
      },
    );

    it('leaves the jitter to TRAA on the temporal chain', () => {
      const water = waterShafts();
      const denoise = vi.spyOn(water, 'denoise');
      build('taa-bloom', water).dispose();
      expect(denoise).not.toHaveBeenCalled();
    });

    it.each(chains)('frees the shaft targets it made: %s', (chain) => {
      const pipeline = build(chain, waterShafts());
      const targets = renderTargets(pipeline.outputNode);
      const disposed = new Set<RenderTarget>();
      for (const target of targets) {
        target.addEventListener('dispose', () => disposed.add(target));
      }
      pipeline.dispose();
      expect([...targets].filter((target) => !disposed.has(target))).toEqual([]);
    });
  });
});
