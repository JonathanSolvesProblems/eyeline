/**
 * Stage placement. Drops the stage onto the first real table or desk the
 * headset reports, lets the user move the whole set by grabbing the plate,
 * parks it on a room anchor, and saves its pose so the set is back where it
 * was left on the next launch.
 */
import {
  createSystem,
  Entity,
  Grabbed,
  Quaternion,
  setWorldPosition,
  setWorldQuaternion,
  Vector3,
  XRAnchor,
  XRMesh,
  XRPlane,
} from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';
import { Placement, SetPiece, StageAnchor } from './set-components.js';

const STORAGE_KEY = 'eyeline.stage.pose.v1';
const TABLE_LABELS = new Set(['table', 'desk']);
const STAGE_LIFT = 0.002;
/** Seconds to keep collecting tables after the first one, so the nearest wins. */
const CANDIDATE_WINDOW = 1.0;
/** Seconds after a session starts to wait for a saved anchor before auto-placing. */
const ANCHOR_WAIT_SECONDS = 8;
const UP = new Vector3(0, 1, 0);

type Candidate = { x: number; top: number; z: number };

export const StageStatus = {
  Floating: 'Floating in front of you. Grab the plate to move the set.',
  Table: 'On your table.',
  Manual: 'Moved by hand. Position saved.',
  Restored: 'Back where you left it.',
} as const;

type SavedPose = { anchored: boolean; position: number[]; quaternion: number[] };
type Globals = { stageStatus: Signal<string>; resetStageRequested: Signal<number> };
type NativePlane = { orientation?: string; semanticLabel?: string };

export class PlacementSystem extends createSystem({
  stages: { required: [SetPiece, StageAnchor] },
  heldStages: { required: [StageAnchor, Grabbed] },
  meshes: { required: [XRMesh] },
  planes: { required: [XRPlane] },
}) {
  private corner = new Vector3();
  private head = new Vector3();
  private centre = new Vector3();
  private yawQuaternion = new Quaternion();
  private authoredPosition = new Vector3();
  private authoredQuaternion = new Quaternion();
  private lastWorldPosition = new Vector3();
  private lastWorldQuaternion = new Quaternion();
  private stageReady = false;
  private attachedSeen = false;
  private tableDone = false;
  private resetSeen = 0;
  private candidates: Candidate[] = [];
  private candidateTimer = -1;
  private sessionElapsed = 0;

  init(): void {
    const g = this.globals as Globals;
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe(() => {
        this.sessionElapsed = 0;
      }),
      this.queries.heldStages.subscribe('qualify', (stage) => {
        stage.setValue(StageAnchor, 'placement', Placement.Manual);
        this.status(StageStatus.Manual);
      }),
      this.queries.heldStages.subscribe('disqualify', (stage) => this.save(stage)),
      this.queries.meshes.subscribe('qualify', (mesh) => this.onSurface(mesh, 'mesh')),
      this.queries.planes.subscribe('qualify', (plane) => this.onSurface(plane, 'plane')),
      g.resetStageRequested.subscribe((n) => {
        if (n > this.resetSeen) {
          this.resetSeen = n;
          this.reset();
        }
      }),
    );
  }

  update(delta: number): void {
    const stage = this.firstStage();
    const object = stage?.object3D;
    if (stage == null || object == null) return;
    if (!this.stageReady) {
      // The qualify event fires before the entity's object exists, so set up here.
      this.stageReady = true;
      this.onStage(stage);
    }
    const attached = stage.hasComponent(XRAnchor) && stage.getValue(XRAnchor, 'attached') === true;
    if (attached && !this.attachedSeen) {
      this.attachedSeen = true;
      // The anchor re-parents the stage. Keep a placed pose, or restore, or fall back.
      const placement = stage.getValue(StageAnchor, 'placement');
      if (placement === Placement.Table || placement === Placement.Manual) {
        setWorldPosition(object, this.lastWorldPosition);
        setWorldQuaternion(object, this.lastWorldQuaternion);
        this.save(stage);
      } else if (!this.tryRestore(stage, true)) {
        // A pose saved without an anchor is not trustworthy in a new session.
        this.applyAuthored(stage);
        stage.setValue(StageAnchor, 'placement', Placement.Floating);
        this.tableDone = false;
        this.status(StageStatus.Floating);
      }
    }
    this.sessionElapsed += delta;
    if (this.candidateTimer >= 0) {
      this.candidateTimer -= delta;
      if (this.candidateTimer <= 0) {
        this.candidateTimer = -1;
        this.chooseTable(stage);
      }
    }
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(this.lastWorldPosition);
    object.getWorldQuaternion(this.lastWorldQuaternion);
  }

  private firstStage(): Entity | undefined {
    return this.queries.stages.entities.values().next().value as Entity | undefined;
  }

  private status(text: string): void {
    (this.globals as Globals).stageStatus.value = text;
  }

  /** Runs once, on the first frame the stage has an object: capture the authored pose, anchor, restore. */
  private onStage(stage: Entity): void {
    const object = stage.object3D!;
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(this.authoredPosition);
    object.getWorldQuaternion(this.authoredQuaternion);
    if (stage.getValue(StageAnchor, 'persist') && !stage.hasComponent(XRAnchor)) {
      stage.addComponent(XRAnchor);
    }
    if (!this.tryRestore(stage, false)) this.status(StageStatus.Floating);
  }

  /** A detected table or desk: place the stage on top of it, facing the user. */
  private onSurface(entity: Entity, kind: 'mesh' | 'plane'): void {
    if (this.tableDone) return;
    const stage = this.firstStage();
    const object = entity.object3D;
    if (stage?.object3D == null || object == null) return;
    if (stage.getValue(StageAnchor, 'placement') !== Placement.Floating) return;
    let top = 0;
    const centre = this.centre;
    if (kind === 'mesh') {
      const label = (entity.getValue(XRMesh, 'semanticLabel') ?? '').toLowerCase();
      if (!TABLE_LABELS.has(label) || !entity.getValue(XRMesh, 'isBounded3D')) return;
      const min = entity.getVectorView(XRMesh, 'min');
      const max = entity.getVectorView(XRMesh, 'max');
      object.updateWorldMatrix(true, false);
      top = -Infinity;
      centre.set(0, 0, 0);
      for (let i = 0; i < 8; i++) {
        this.corner.set(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
        object.localToWorld(this.corner);
        top = Math.max(top, this.corner.y);
        centre.x += this.corner.x / 8;
        centre.z += this.corner.z / 8;
      }
    } else {
      const plane = entity.getValue(XRPlane, '_plane') as NativePlane | undefined;
      const label = (plane?.semanticLabel ?? '').toLowerCase();
      if (plane?.orientation !== 'horizontal' || !TABLE_LABELS.has(label)) return;
      object.getWorldPosition(centre);
      top = centre.y;
    }
    this.candidates.push({ x: centre.x, top, z: centre.z });
    if (this.candidateTimer < 0) this.candidateTimer = CANDIDATE_WINDOW;
  }

  /** After the window closes, the table nearest the user wins. */
  private chooseTable(stage: Entity): void {
    const candidates = this.candidates;
    this.candidates = [];
    if (this.tableDone || candidates.length === 0) return;
    if (stage.getValue(StageAnchor, 'placement') !== Placement.Floating) return;
    // A saved anchored pose outranks auto-placement; give the anchor time to attach.
    const anchorPending =
      !this.attachedSeen && this.sessionElapsed < ANCHOR_WAIT_SECONDS && this.load()?.anchored === true;
    if (anchorPending) {
      this.candidates = candidates;
      this.candidateTimer = 0.5;
      return;
    }
    this.player.head.getWorldPosition(this.head);
    let best = candidates[0];
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const distance = Math.hypot(candidate.x - this.head.x, candidate.z - this.head.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    this.placeOnTable(stage, best.x, best.top, best.z);
  }

  private placeOnTable(stage: Entity, x: number, top: number, z: number): void {
    const object = stage.object3D!;
    this.player.head.getWorldPosition(this.head);
    const yaw = Math.atan2(this.head.x - x, this.head.z - z);
    this.corner.set(x, top + STAGE_LIFT, z);
    setWorldPosition(object, this.corner);
    setWorldQuaternion(object, this.yawQuaternion.setFromAxisAngle(UP, yaw));
    stage.setValue(StageAnchor, 'placement', Placement.Table);
    this.tableDone = true;
    this.status(StageStatus.Table);
    this.save(stage);
  }

  private applyAuthored(stage: Entity): void {
    const object = stage.object3D!;
    setWorldPosition(object, this.authoredPosition);
    setWorldQuaternion(object, this.authoredQuaternion);
  }

  private save(stage: Entity): void {
    const object = stage.object3D;
    if (object == null || !stage.getValue(StageAnchor, 'persist')) return;
    const anchored = stage.hasComponent(XRAnchor) && stage.getValue(XRAnchor, 'attached') === true;
    const pose: SavedPose = {
      anchored,
      position: object.position.toArray(),
      quaternion: object.quaternion.toArray() as number[],
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pose));
    } catch {
      // Storage unavailable; the pose lives for this session only.
    }
  }

  private load(): SavedPose | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as SavedPose) : null;
    } catch {
      return null;
    }
  }

  /** Re-apply a saved pose when it was saved in the same frame (anchored or not). */
  private tryRestore(stage: Entity, anchored: boolean): boolean {
    const pose = this.load();
    const object = stage.object3D;
    if (pose == null || object == null || pose.anchored !== anchored) return false;
    if (pose.position.length !== 3 || pose.quaternion.length !== 4) return false;
    object.position.fromArray(pose.position);
    object.quaternion.fromArray(pose.quaternion);
    stage.setValue(StageAnchor, 'placement', Placement.Restored);
    this.tableDone = true;
    this.status(StageStatus.Restored);
    return true;
  }

  private reset(): void {
    const stage = this.firstStage();
    if (stage?.object3D == null) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing saved to clear.
    }
    this.applyAuthored(stage);
    stage.setValue(StageAnchor, 'placement', Placement.Floating);
    this.tableDone = false;
    this.status(StageStatus.Floating);
  }
}
