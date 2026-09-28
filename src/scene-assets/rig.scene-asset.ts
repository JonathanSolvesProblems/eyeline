/**
 * The miniature stage plate and the shot camera rig, both at 1:10.
 * Stage origin is the centre of its top surface. Camera rig origin is its
 * base contact; the lens points down -Z, matching a three.js camera.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from '@iwsdk/core';

function gridLines(width: number, depth: number, step: number): BufferGeometry {
  const points: number[] = [];
  for (let x = -width / 2; x <= width / 2 + 1e-6; x += step) {
    points.push(x, 0, -depth / 2, x, 0, depth / 2);
  }
  for (let z = -depth / 2; z <= depth / 2 + 1e-6; z += step) {
    points.push(-width / 2, 0, z, width / 2, 0, z);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  return geometry;
}

function stage(): Group {
  const group = new Group();
  group.name = 'Stage';
  const plate = new Mesh(
    new BoxGeometry(0.6, 0.012, 0.4),
    new MeshStandardMaterial({ color: 0x1e2126, roughness: 0.95 }),
  );
  plate.name = 'Plate';
  plate.position.y = -0.006;
  // One real metre per cell.
  const grid = new LineSegments(gridLines(0.6, 0.4, 0.1), new LineBasicMaterial({ color: 0x4a5260 }));
  grid.name = 'Grid';
  grid.position.y = 0.0005;
  group.add(plate, grid);
  return group;
}

function cameraRig(): Group {
  const group = new Group();
  group.name = 'CameraRig';
  const metal = new MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.6, metalness: 0.6 });
  const base = new Mesh(new CylinderGeometry(0.02, 0.022, 0.004, 20), new MeshStandardMaterial({ color: 0x2a2d31 }));
  base.name = 'Base';
  base.position.y = 0.002;
  const post = new Mesh(new CylinderGeometry(0.004, 0.004, 0.1, 8), metal);
  post.name = 'Post';
  post.position.y = 0.054;
  const body = new Mesh(
    new BoxGeometry(0.036, 0.028, 0.05),
    new MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.5, metalness: 0.3 }),
  );
  body.name = 'Body';
  body.position.y = 0.118;
  const lens = new Mesh(
    new CylinderGeometry(0.009, 0.011, 0.03, 16),
    new MeshStandardMaterial({ color: 0x151517, roughness: 0.4, metalness: 0.5 }),
  );
  lens.name = 'Lens';
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0.118, -0.04);
  const tally = new Mesh(
    new SphereGeometry(0.003, 8, 6),
    new MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff3b30, emissiveIntensity: 1 }),
  );
  tally.name = 'Tally';
  tally.position.set(0.012, 0.135, 0.02);
  group.add(base, post, body, lens, tally);
  return group;
}

export const stagePlate = stage();
export const cameraRigModel = cameraRig();
