import { createSystem, UIKit, UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import type { Signal } from '@preact/signals-core';
import { StageStatus } from './placement.js';

const LENSES = [24, 35, 50, 85];
const SHOT_ROWS = 6;
const STATUS_PLACED = '#cfead7';
const STATUS_IDLE = '#e6e8ec';
const PLACED_STATUSES = new Set<string>([StageStatus.Table, StageStatus.Restored, StageStatus.Manual]);

type Globals = {
  lensMm: Signal<number>;
  snapRequested: Signal<number>;
  eyelineText: Signal<string[]>;
  shotList: Signal<string[]>;
  stageStatus: Signal<string>;
  resetStageRequested: Signal<number>;
};

/** Wires the Eyeline control panel to the shared signals the viewfinder reads. */
export class ControlsSystem extends createSystem({}) {
  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('controls-panel');
    if (panel == null) return;
    const g = this.globals as Globals;

    for (const mm of LENSES) {
      const button = panel.getElementById(`lens-${mm}`);
      if (button == null) continue;
      const pick = () => {
        g.lensMm.value = mm;
      };
      button.addEventListener('click', pick);
      this.cleanupFuncs.push(() => button.removeEventListener('click', pick));
    }
    this.cleanupFuncs.push(
      g.lensMm.subscribe((mm) => {
        for (const l of LENSES) {
          panel.getElementById(`lens-${l}`)?.setProperties({
            backgroundColor: l === mm ? '#ffb020' : '#e6e8ec',
          });
        }
      }),
    );

    const stageStatus = panel.getElementById<UIKit.Text>('stage-status');
    this.cleanupFuncs.push(
      g.stageStatus.subscribe((text) => {
        stageStatus?.setProperties({
          text,
          backgroundColor: PLACED_STATUSES.has(text) ? STATUS_PLACED : STATUS_IDLE,
        });
      }),
    );
    const resetStage = panel.getElementById('btn-reset-stage');
    const requestReset = () => {
      g.resetStageRequested.value = g.resetStageRequested.value + 1;
    };
    resetStage?.addEventListener('click', requestReset);
    this.cleanupFuncs.push(() => resetStage?.removeEventListener('click', requestReset));

    const snap = panel.getElementById('btn-snap');
    const requestSnap = () => {
      g.snapRequested.value = g.snapRequested.value + 1;
    };
    snap?.addEventListener('click', requestSnap);
    this.cleanupFuncs.push(() => snap?.removeEventListener('click', requestSnap));

    const eyeA = panel.getElementById<UIKit.Text>('eyeline-a');
    const eyeB = panel.getElementById<UIKit.Text>('eyeline-b');
    this.cleanupFuncs.push(
      g.eyelineText.subscribe((lines) => {
        eyeA?.setProperties({ text: lines[0] ?? 'A: place the creature and an actor' });
        eyeB?.setProperties({ text: lines[1] ?? '' });
      }),
      g.shotList.subscribe((lines) => {
        for (let i = 0; i < SHOT_ROWS; i++) {
          const row = panel.getElementById<UIKit.Text>(`shot-${i + 1}`);
          const fallback = i === 0 ? 'No frames yet. Move the camera, then snap.' : '';
          row?.setProperties({ text: lines[i] ?? fallback });
        }
      }),
    );

    const xrButton = panel.getElementById('xr-button');
    const exitButton = panel.getElementById('exit-button');
    if (xrButton == null || exitButton == null) return;
    if (!this.world.xrEnabled) {
      xrButton.setProperties({ display: 'none' });
      exitButton.setProperties({ display: 'none' });
      return;
    }
    const launchXR = () => this.world.launchXR();
    const exitXR = () => this.world.exitXR();
    xrButton.addEventListener('click', launchXR);
    exitButton.addEventListener('click', exitXR);
    this.cleanupFuncs.push(
      () => xrButton.removeEventListener('click', launchXR),
      () => exitButton.removeEventListener('click', exitXR),
      this.world.visibilityState.subscribe((state) => {
        const is2D = state === VisibilityState.NonImmersive;
        xrButton.setProperties({ display: is2D ? 'flex' : 'none' });
        exitButton.setProperties({ display: is2D ? 'none' : 'flex' });
      }),
    );
  }
}
