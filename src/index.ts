import { World } from '@iwsdk/core';
import { signal } from '@preact/signals-core';
import projectOptions from 'virtual:iwsdk-project';
import { ControlsSystem } from './controls.js';
import { ViewfinderSystem } from './viewfinder.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // Shared state between the control panel and the viewfinder.
  const globals = world.globals as Record<string, unknown>;
  globals.lensMm = signal(35);
  globals.snapRequested = signal(0);
  globals.eyelineText = signal<string[]>([]);
  globals.shotList = signal<string[]>([]);

  world
    .registerSystem(ViewfinderSystem, { priority: 20 })
    .registerSystem(ControlsSystem, { priority: 30 });

  // Debug and test hook: lets scripts drive the app from the page.
  (globalThis as Record<string, unknown>).eyeline = { world };
});
