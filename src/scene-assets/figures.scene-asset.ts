/**
 * Stylised previs mannequins at 1:10. Each figure stands on its own base with
 * its origin at floor contact and faces -Z. Named parts: Base, Body, Head, Eye.
 */
import {
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from '@iwsdk/core';

const SCALE = 0.1; // one real metre is 0.1 m on the stage

const baseMaterial = new MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.9 });

function figure(
  name: string,
  realHeightM: number,
  bodyColor: number,
  eyeColor: number,
): Group {
  const h = realHeightM * SCALE;
  const headR = h * 0.075;
  const bodyR = h * 0.11;
  const bodyLen = Math.max(h - 2 * headR - 2 * bodyR, 0.01);
  const skin = new MeshStandardMaterial({ color: bodyColor, roughness: 0.65 });

  const base = new Mesh(new CylinderGeometry(bodyR * 1.3, bodyR * 1.4, 0.004, 20), baseMaterial);
  base.name = 'Base';
  base.position.y = 0.002;

  const body = new Mesh(new CapsuleGeometry(bodyR, bodyLen, 4, 14), skin);
  body.name = 'Body';
  body.position.y = bodyR + bodyLen / 2;

  const head = new Mesh(new SphereGeometry(headR, 18, 14), skin);
  head.name = 'Head';
  head.position.y = h - headR;

  const eye = new Mesh(
    new SphereGeometry(headR * 0.28, 10, 8),
    new MeshStandardMaterial({ color: eyeColor, emissive: eyeColor, emissiveIntensity: 0.6 }),
  );
  eye.name = 'Eye';
  eye.position.set(0, h - headR, -headR * 0.85);

  const group = new Group();
  group.name = name;
  group.add(base, body, head, eye);
  return group;
}

export const actorA = figure('ActorA', 1.7, 0x3d7bd9, 0xffffff);
export const actorB = figure('ActorB', 1.65, 0xd95f3d, 0xffffff);
export const creature = figure('Creature', 3.5, 0x5fbf6a, 0xfff06a);
