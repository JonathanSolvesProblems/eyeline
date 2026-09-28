import { AssetType, defineAssets } from '@iwsdk/core';
import { actorA, actorB, creature } from './scene-assets/figures.scene-asset.js';
import { cameraRigModel, stagePlate } from './scene-assets/rig.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  stage: stagePlate,
  'actor-a': actorA,
  'actor-b': actorB,
  creature: creature,
  'camera-rig': cameraRigModel,
  'controls-panel': {
    url: publicAssetUrl('ui/controls.uikitml'),
    type: AssetType.UIKitML,
    name: 'Controls Panel',
  },
});
