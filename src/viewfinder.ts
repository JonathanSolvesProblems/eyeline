/**
 * Eyeline viewfinder. Renders the shot camera's view into a texture shown on a
 * monitor above the stage, draws actor-to-creature eyelines, and captures
 * storyboard frames on request. All distances reported to the panel are in
 * real set metres (stage scale is 1:10).
 */
import {
  AudioUtils,
  BufferGeometry,
  CanvasTexture,
  Color,
  createSystem,
  Entity,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';
import { SetPiece, SetRole, ShotCamera } from './set-components.js';

/** One miniature metre on the stage is ten real metres on set. */
export const SET_SCALE = 10;
/** Vertical sensor size of a 36 mm wide full-frame sensor cropped to 16:9. */
const SENSOR_HEIGHT_MM = 20.25;
const RT_WIDTH = 640;
const RT_HEIGHT = 360;
const MAX_FRAMES = 6;
const FRAME_WIDTH = 0.1;
const MAX_ACTORS = 4;
const TEXT_EVERY_N_FRAMES = 12;
/** Monitor pose relative to the stage origin, so it travels with the stage. */
const MONITOR_LOCAL: [number, number, number] = [0, 0.37, -0.31];

export interface Shot {
  index: number;
  lensMm: number;
  cameraHeightM: number;
  distanceToCreatureM: number;
  eyelineDeg: number;
  dataUrl: string;
}

type Globals = {
  lensMm: Signal<number>;
  snapRequested: Signal<number>;
  eyelineText: Signal<string[]>;
  shotList: Signal<string[]>;
};

type AsyncReader = WebGLRenderer & {
  readRenderTargetPixelsAsync?: (
    target: WebGLRenderTarget,
    x: number,
    y: number,
    width: number,
    height: number,
    buffer: Uint8Array,
  ) => Promise<Uint8Array>;
};

export class ViewfinderSystem extends createSystem({
  cams: { required: [ShotCamera] },
  pieces: { required: [SetPiece] },
}) {
  private target!: WebGLRenderTarget;
  private lensCamera!: PerspectiveCamera;
  private monitor: Mesh | null = null;
  private stageEntity: Entity | null = null;
  private lines: Line[] = [];
  private frames: (Entity | null)[] = [];
  private shots: Shot[] = [];
  private actors: Entity[] = [];
  private rises = new Float32Array(MAX_ACTORS);
  private runs = new Float32Array(MAX_ACTORS);
  private frameCount = 0;
  private snapPending = false;
  private prevClear = new Color();
  private a = new Vector3();
  private b = new Vector3();
  private c = new Vector3();

  init(): void {
    this.target = new WebGLRenderTarget(RT_WIDTH, RT_HEIGHT);
    this.target.texture.colorSpace = SRGBColorSpace;
    this.lensCamera = new PerspectiveCamera(40, RT_WIDTH / RT_HEIGHT, 0.02, 50);
    this.lensCamera.name = 'ShotLens';

    // The monitor is created once the stage entity exists; see ensureMonitor().

    const attach = (entity: Entity) => {
      entity.object3D?.add(this.lensCamera);
      // Just in front of the lens barrel, so the rig's own body is never in frame.
      this.lensCamera.position.set(0, 0.118, -0.06);
    };
    this.queries.cams.entities.forEach(attach);
    this.cleanupFuncs.push(
      this.queries.cams.subscribe('qualify', attach),
      this.queries.cams.subscribe('disqualify', () => this.lensCamera.removeFromParent()),
    );

    const g = this.globals as Globals;
    this.cleanupFuncs.push(
      g.lensMm.subscribe((mm) => this.setLens(mm)),
      g.snapRequested.subscribe((n) => {
        if (n > 0) this.snapPending = true;
      }),
      () => this.target.dispose(),
    );
  }

  getShots(): readonly Shot[] {
    return this.shots;
  }

  /** The monitor is a child of the stage, so it travels wherever the stage is placed. */
  private ensureMonitor(): boolean {
    if (this.monitor != null) return true;
    const stage = this.findRole(SetRole.Stage);
    if (stage?.object3D == null) return false;
    this.stageEntity = stage;
    const monitor = new Mesh(
      new PlaneGeometry(0.32, 0.18),
      new MeshBasicMaterial({ map: this.target.texture, toneMapped: false }),
    );
    monitor.name = 'Viewfinder';
    this.world.createTransformEntity(monitor, { parent: stage });
    monitor.position.set(...MONITOR_LOCAL);
    monitor.rotation.x = -0.15;
    this.monitor = monitor;
    return true;
  }

  private setLens(mm: number): void {
    this.lensCamera.fov = (2 * Math.atan(SENSOR_HEIGHT_MM / (2 * mm)) * 180) / Math.PI;
    this.lensCamera.updateProjectionMatrix();
    for (const cam of this.queries.cams.entities) cam.setValue(ShotCamera, 'lensMm', mm);
  }

  update(): void {
    const cam = this.queries.cams.entities.values().next().value as Entity | undefined;
    if (cam?.object3D == null || !this.ensureMonitor()) return;
    this.updateEyelines();
    this.renderViewfinder();
    if (this.snapPending) {
      this.snapPending = false;
      void this.captureFrame(cam);
    }
  }

  private findRole(role: string): Entity | undefined {
    for (const piece of this.queries.pieces.entities) {
      if (piece.getValue(SetPiece, 'role') === role) return piece;
    }
    return undefined;
  }

  /** World-space eye point of a piece, honouring its rotation. */
  private eyePoint(piece: Entity, out: Vector3): Vector3 {
    const object = piece.object3D!;
    object.updateWorldMatrix(true, false);
    out.set(0, piece.getValue(SetPiece, 'eyeHeight') ?? 0, 0);
    return object.localToWorld(out);
  }

  private ensureLine(i: number): Line {
    let line = this.lines[i];
    if (line == null) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
      line = new Line(geometry, new LineBasicMaterial({ color: 0xffb020 }));
      line.name = `Eyeline${i + 1}`;
      line.frustumCulled = false;
      this.world.createTransformEntity(line);
      this.lines[i] = line;
    }
    return line;
  }

  private updateEyelines(): void {
    const creature = this.findRole(SetRole.Creature);
    this.actors.length = 0;
    for (const piece of this.queries.pieces.entities) {
      if (piece.getValue(SetPiece, 'role') === SetRole.Actor && this.actors.length < MAX_ACTORS) {
        this.actors.push(piece);
      }
    }
    if (creature?.object3D == null) return;
    this.eyePoint(creature, this.c);
    for (let i = 0; i < this.actors.length; i++) {
      const actor = this.actors[i];
      if (actor.object3D == null) continue;
      this.eyePoint(actor, this.a);
      const line = this.ensureLine(i);
      const position = line.geometry.getAttribute('position') as Float32BufferAttribute;
      position.setXYZ(0, this.a.x, this.a.y, this.a.z);
      position.setXYZ(1, this.c.x, this.c.y, this.c.z);
      position.needsUpdate = true;
      line.visible = true;
      this.rises[i] = this.c.y - this.a.y;
      this.runs[i] = Math.hypot(this.c.x - this.a.x, this.c.z - this.a.z);
    }
    for (let i = this.actors.length; i < this.lines.length; i++) this.lines[i].visible = false;
    if (this.frameCount++ % TEXT_EVERY_N_FRAMES === 0) this.publishEyelineText();
  }

  private eyelineDeg(i: number): number {
    return (Math.atan2(this.rises[i], this.runs[i]) * 180) / Math.PI;
  }

  private publishEyelineText(): void {
    const lines: string[] = [];
    for (let i = 0; i < this.actors.length; i++) {
      const label = this.actors[i].getValue(SetPiece, 'label') || `Actor ${i + 1}`;
      const deg = this.eyelineDeg(i);
      const rise = this.rises[i] * SET_SCALE;
      const run = this.runs[i] * SET_SCALE;
      lines.push(
        `${label}: look ${deg >= 0 ? 'up' : 'down'} ${Math.abs(deg).toFixed(0)} deg, ` +
          `eye ${Math.abs(rise).toFixed(1)} m ${rise >= 0 ? 'above' : 'below'}, ${run.toFixed(1)} m away`,
      );
    }
    const g = this.globals as Globals;
    const current = g.eyelineText.value;
    if (current.length === lines.length && current.every((l, i) => l === lines[i])) return;
    g.eyelineText.value = lines;
  }

  /** Off-screen pass from the shot camera, inside the same XR frame. */
  private renderViewfinder(): void {
    const renderer = this.renderer;
    const xr = renderer.xr;
    const xrWasEnabled = xr.enabled;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(this.prevClear);
    const prevAlpha = renderer.getClearAlpha();

    const monitor = this.monitor!;
    monitor.visible = false;
    xr.enabled = false;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x0f1114, 1);
    renderer.autoClear = true;
    renderer.render(this.scene, this.lensCamera);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(this.prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
    xr.enabled = xrWasEnabled;
    monitor.visible = true;
  }

  private async captureFrame(cam: Entity): Promise<void> {
    const w = RT_WIDTH;
    const h = RT_HEIGHT;
    const pixels = new Uint8Array(w * h * 4);
    const renderer = this.renderer as AsyncReader;
    if (renderer.readRenderTargetPixelsAsync) {
      await renderer.readRenderTargetPixelsAsync(this.target, 0, 0, w, h, pixels);
    } else {
      renderer.readRenderTargetPixels(this.target, 0, 0, w, h, pixels);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx == null) return;
    const image = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      image.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    }
    ctx.putImageData(image, 0, 0);

    const stage = this.findRole(SetRole.Stage);
    const creature = this.findRole(SetRole.Creature);
    this.lensCamera.getWorldPosition(this.a);
    const stageY = stage?.object3D ? stage.object3D.getWorldPosition(this.b).y : this.a.y;
    let distance = 0;
    if (creature?.object3D) {
      creature.object3D.getWorldPosition(this.b);
      distance = Math.hypot(this.b.x - this.a.x, this.b.z - this.a.z);
    }
    const g = this.globals as Globals;
    const shot: Shot = {
      index: this.shots.length + 1,
      lensMm: g.lensMm.peek(),
      cameraHeightM: (this.a.y - stageY) * SET_SCALE,
      distanceToCreatureM: distance * SET_SCALE,
      eyelineDeg: this.actors.length > 0 ? this.eyelineDeg(0) : 0,
      dataUrl: canvas.toDataURL('image/png'),
    };
    this.shots.push(shot);
    this.placeThumbnail(canvas, shot.index);
    AudioUtils.play(cam);
    g.shotList.value = this.shots
      .slice(-MAX_FRAMES)
      .map(
        (s) =>
          `${s.index}. ${s.lensMm} mm, cam ${s.cameraHeightM.toFixed(1)} m high, ` +
          `${s.distanceToCreatureM.toFixed(1)} m from creature`,
      );
  }

  private placeThumbnail(canvas: HTMLCanvasElement, index: number): void {
    const slot = (index - 1) % MAX_FRAMES;
    this.frames[slot]?.dispose();
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(
      new PlaneGeometry(FRAME_WIDTH, (FRAME_WIDTH * 9) / 16),
      new MeshBasicMaterial({ map: texture, toneMapped: false }),
    );
    mesh.name = `Frame${index}`;
    const entity = this.world.createTransformEntity(mesh, { parent: this.stageEntity ?? undefined });
    const x = (slot - (MAX_FRAMES - 1) / 2) * (FRAME_WIDTH + 0.012);
    mesh.position.set(MONITOR_LOCAL[0] + x, MONITOR_LOCAL[1] - 0.15, MONITOR_LOCAL[2]);
    mesh.rotation.x = -0.15;
    this.frames[slot] = entity;
  }
}
