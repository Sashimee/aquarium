import { Raycaster, Vector2 } from 'three/webgpu';
import type { Engine } from '../../engine/Engine';
import type { EventBus } from '../../engine/events';
import { WATER_INSET } from '../../engine/tank/dimensions';
import type { Vec3 } from '../camera';
import type {
  DecorCommand,
  DecorPaletteEntry,
  DecorPieceView,
  DecorViewState,
  InteractionEvents,
} from '../events';
import type { SavedDecor } from './binding';
import { DecorEditor } from './editor';
import type { Piece } from './layout';
import { describeRejection } from './rules';
import type { DecorWorld } from './world';

const COLLIDER_SYNC_MS = 100;

export interface DecorModeDeps {
  readonly engine: Engine;
  readonly world: DecorWorld;
  readonly saved: SavedDecor;
  readonly interaction: EventBus<InteractionEvents>;
  readonly reducedMotion: () => boolean;
  readonly now?: () => number;
}

interface Grab {
  readonly planeY: number;
}

/** Decorate mode: the pointer picks and drags pieces, the editor decides, the world shows it. */
export class DecorMode {
  private editor: DecorEditor | null = null;
  private grab: Grab | null = null;
  private lastColliderSync = 0;
  private stopFrame: (() => void) | null = null;
  private stopCommands: (() => void) | null = null;
  private wasBusy = false;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly now: () => number;

  constructor(private readonly deps: DecorModeDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  get active(): boolean {
    return this.editor !== null;
  }

  /** While true a one-finger drag moves a piece instead of orbiting the camera. */
  get claimsDrag(): boolean {
    return this.editor?.dragging ?? false;
  }

  start(): boolean {
    if (this.editor) return true;
    const { world, saved, interaction, engine } = this.deps;
    if (!saved.editable) {
      this.publish(
        'This scene shows a different kind of tank, so its decor cannot be changed here.',
      );
      return false;
    }
    const dims = engine.tank.dimensions;
    this.editor = new DecorEditor({
      specs: world.specs,
      limits: {
        halfLength: dims.length / 2 - dims.glass - WATER_INSET,
        halfDepth: dims.depth / 2 - dims.glass - WATER_INSET,
      },
      ground: (x, z) => world.groundHeight(x, z),
      pieces: world.pieces,
    });
    this.stopCommands = interaction.on('decor:command', (command) => this.command(command));
    this.stopFrame = engine.onFrame((deltaS) => this.frame(deltaS));
    interaction.emit('decor:mode-changed', { active: true });
    this.publish();
    return true;
  }

  stop(): void {
    const editor = this.editor;
    if (!editor) return;
    this.pointerUp();
    this.stopFrame?.();
    this.stopCommands?.();
    this.stopFrame = null;
    this.stopCommands = null;
    const final = editor.settleNow();
    for (const piece of final) this.deps.world.preview(piece);
    this.commit(editor);
    this.editor = null;
    this.deps.interaction.emit('decor:mode-changed', { active: false });
    this.deps.interaction.emit('decor:state', { ...this.emptyState(), active: false });
  }

  dispose(): void {
    this.stop();
  }

  tap(x: number, y: number): void {
    const editor = this.editor;
    if (!editor || editor.dragging) return;
    const ray = this.rayAt(x, y);
    editor.select(ray ? (editor.pick(ray)?.id ?? null) : null);
    this.publish();
  }

  pointerDown(x: number, y: number): void {
    const editor = this.editor;
    const ray = this.rayAt(x, y);
    if (!editor || !ray) return;
    const hit = editor.pick(ray);
    if (!hit) return;
    const point = {
      x: ray.origin.x + ray.dir.x * hit.t,
      y: ray.origin.y + ray.dir.y * hit.t,
      z: ray.origin.z + ray.dir.z * hit.t,
    };
    if (editor.grab(hit.id, point)) {
      this.grab = { planeY: point.y };
      this.publish();
    }
  }

  pointerMove(x: number, y: number): void {
    const editor = this.editor;
    const grab = this.grab;
    if (!editor || !grab || !editor.dragging) return;
    const ray = this.rayAt(x, y);
    if (!ray || Math.abs(ray.dir.y) < 1e-6) return;
    const t = (grab.planeY - ray.origin.y) / ray.dir.y;
    if (!(t > 0)) return;
    const piece = editor.dragTo(ray.origin.x + ray.dir.x * t, ray.origin.z + ray.dir.z * t);
    if (!piece) return;
    this.deps.world.preview(piece);
    const nowMs = this.now();
    if (nowMs - this.lastColliderSync >= COLLIDER_SYNC_MS) {
      this.lastColliderSync = nowMs;
      this.deps.world.emitColliders();
    }
    this.publish();
  }

  pointerUp(): void {
    const editor = this.editor;
    if (!editor || !this.grab) return;
    this.grab = null;
    const piece = editor.pieces.find((p) => p.id === editor.selectedId);
    const result = editor.drop();
    if (result === 'reverted' && piece) {
      const back = editor.piece(piece.id);
      if (back) this.deps.world.preview(back);
      editor.problem ??= describeRejection('overlap');
    }
    if (result === 'moved' && this.deps.reducedMotion()) {
      for (const p of editor.settleNow()) this.deps.world.preview(p);
    }
    this.deps.world.emitColliders();
    this.publish();
  }

  private command(command: DecorCommand): void {
    const editor = this.editor;
    if (!editor) return;
    switch (command.type) {
      case 'select':
        editor.select(command.id);
        break;
      case 'add': {
        const result = editor.add(command.assetId);
        if ('rejection' in result) {
          editor.problem = describeRejection(result.rejection);
        } else {
          if (this.deps.reducedMotion()) editor.settleNow();
          void this.restructure(editor);
        }
        break;
      }
      case 'remove':
        if (editor.remove(command.id)) void this.restructure(editor);
        break;
      case 'rotate':
        if (editor.rotate(command.id, command.radians)) this.refresh(editor, command.id);
        break;
      case 'nudge':
        if (editor.nudge(command.id, command.dx, command.dz)) this.refresh(editor, command.id);
        break;
      case 'retry-save':
        return;
    }
    this.publish();
  }

  /** The set of pieces changed, so the scene rebuilds its hardscape and re-applies current heights. */
  private async restructure(editor: DecorEditor): Promise<void> {
    const { world } = this.deps;
    try {
      await world.show(editor.restingPieces());
      if (this.editor !== editor) return;
      for (const piece of editor.pieces) world.preview(piece);
      this.commit(editor);
    } catch (cause) {
      this.deps.engine.events.emit('engine:error', {
        message: 'Could not update the decor',
        cause,
      });
    }
    this.publish();
  }

  private refresh(editor: DecorEditor, id: string): void {
    const piece = editor.piece(id);
    if (piece) this.deps.world.preview(piece);
    this.commit(editor);
  }

  private commit(editor: DecorEditor): void {
    const { world, saved, interaction } = this.deps;
    world.emitColliders();
    const tankId = saved.tankId;
    if (tankId) {
      interaction.emit('decor:layout', { tankId, layout: world.layout(editor.restingPieces()) });
    }
  }

  private frame(deltaS: number): void {
    const editor = this.editor;
    if (!editor) return;
    const moved = editor.step(deltaS);
    for (const piece of moved) this.deps.world.preview(piece);
    const busy = editor.busy;
    if (this.wasBusy && !busy) {
      this.commit(editor);
      this.publish();
    }
    this.wasBusy = busy;
  }

  private rayAt(x: number, y: number) {
    const { engine } = this.deps;
    const canvas = engine.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return null;
    this.ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, engine.camera);
    const { origin, direction } = this.raycaster.ray;
    const dir: Vec3 = { x: direction.x, y: direction.y, z: direction.z };
    return { origin: { x: origin.x, y: origin.y, z: origin.z }, dir };
  }

  private emptyState(): DecorViewState {
    return {
      active: false,
      persisted: false,
      palette: [],
      pieces: [],
      selectedId: null,
      hasFeeder: false,
      problem: null,
    };
  }

  private publish(problem?: string): void {
    const editor = this.editor;
    const { world, saved, interaction } = this.deps;
    const palette: DecorPaletteEntry[] = [...world.specs.values()]
      .map((s) => ({ assetId: s.assetId, label: s.label, kind: s.kind }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const pieces: DecorPieceView[] = labelPieces(editor?.pieces ?? [], world);
    interaction.emit('decor:state', {
      active: editor !== null,
      persisted: saved.tankId !== null,
      palette,
      pieces,
      selectedId: editor?.selectedId ?? null,
      hasFeeder: editor?.hasFeeder ?? false,
      problem: problem ?? editor?.problem ?? null,
    });
  }
}

export function labelPieces(
  pieces: readonly Piece[],
  world: Pick<DecorWorld, 'specs'>,
): DecorPieceView[] {
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const p of pieces) total.set(p.item.assetId, (total.get(p.item.assetId) ?? 0) + 1);
  return pieces.map((p) => {
    const base = world.specs.get(p.item.assetId)?.label ?? p.item.assetId;
    const n = (seen.get(p.item.assetId) ?? 0) + 1;
    seen.set(p.item.assetId, n);
    return { id: p.id, label: (total.get(p.item.assetId) ?? 1) > 1 ? `${base} ${n}` : base };
  });
}
