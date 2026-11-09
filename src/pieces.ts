/**
 * Pieces module for Hand Chess VR.
 * Creates simple, bold, and large 3D chess pieces designed specifically
 * for ergonomic grabbing with hands in Meta Quest WebXR.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
} from '@iwsdk/core';

export type PieceType = 'pawn' | 'rook' | 'knight' | 'bishop' | 'queen' | 'king';
export type PieceColor = 'white' | 'black';

// High-visibility, tactile physical materials with clearcoat
export const whitePieceMaterial = new MeshPhysicalMaterial({
  color: 0xf8f9fa, // Pure ivory white
  roughness: 0.25,
  metalness: 0.02,
  clearcoat: 0.5,
  clearcoatRoughness: 0.2,
});

export const blackPieceMaterial = new MeshPhysicalMaterial({
  color: 0x1e2024, // Deep obsidian charcoal
  roughness: 0.28,
  metalness: 0.05,
  clearcoat: 0.5,
  clearcoatRoughness: 0.2,
});

export const baseFeltMaterial = new MeshStandardMaterial({
  color: 0x15803d, // Classic green felt bottom
  roughness: 0.9,
  metalness: 0.0,
});

/**
 * Creates standard weighted base for all pieces.
 */
function createBase(radius: number, height: number, material: MeshPhysicalMaterial): Group {
  const baseGroup = new Group();

  // Green felt underside
  const feltGeo = new CylinderGeometry(radius * 0.96, radius * 0.96, 0.002, 24);
  const felt = new Mesh(feltGeo, baseFeltMaterial);
  felt.position.y = 0.001;
  baseGroup.add(felt);

  // Bottom tier
  const b1 = new Mesh(new CylinderGeometry(radius, radius * 1.05, height * 0.55, 24), material);
  b1.position.y = height * 0.275;
  b1.castShadow = true;
  baseGroup.add(b1);

  // Bevel ring
  const torus = new Mesh(new TorusGeometry(radius * 0.88, radius * 0.12, 10, 24), material);
  torus.rotation.x = Math.PI / 2;
  torus.position.y = height * 0.55;
  torus.castShadow = true;
  baseGroup.add(torus);

  // Upper base taper
  const b2 = new Mesh(new CylinderGeometry(radius * 0.72, radius * 0.88, height * 0.45, 24), material);
  b2.position.y = height * 0.775;
  b2.castShadow = true;
  baseGroup.add(b2);

  return baseGroup;
}

/**
 * 1. Large Pawn: Chunky cylinder base with large smooth spherical head.
 * Height: ~8.2cm | Base Diameter: ~5.0cm
 */
export function createPawn(color: PieceColor): Group {
  const mat = color === 'white' ? whitePieceMaterial : blackPieceMaterial;
  const piece = new Group();
  piece.name = `pawn-${color}`;

  const base = createBase(0.024, 0.022, mat);
  piece.add(base);

  // Stem
  const stem = new Mesh(new CylinderGeometry(0.015, 0.018, 0.032, 20), mat);
  stem.position.y = 0.038;
  stem.castShadow = true;
  piece.add(stem);

  // Collar
  const collar = new Mesh(new TorusGeometry(0.016, 0.003, 8, 20), mat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.054;
  collar.castShadow = true;
  piece.add(collar);

  // Head sphere (big enough to pinch easily)
  const head = new Mesh(new SphereGeometry(0.018, 24, 24), mat);
  head.position.y = 0.070;
  head.castShadow = true;
  piece.add(head);

  return piece;
}

/**
 * 2. Large Rook: Castle turret tower with battlements.
 * Height: ~9.5cm | Base Diameter: ~5.4cm
 */
export function createRook(color: PieceColor): Group {
  const mat = color === 'white' ? whitePieceMaterial : blackPieceMaterial;
  const piece = new Group();
  piece.name = `rook-${color}`;

  const base = createBase(0.026, 0.024, mat);
  piece.add(base);

  // Tower body
  const body = new Mesh(new CylinderGeometry(0.020, 0.022, 0.046, 24), mat);
  body.position.y = 0.047;
  body.castShadow = true;
  piece.add(body);

  // Cornice
  const cornice = new Mesh(new CylinderGeometry(0.025, 0.020, 0.008, 24), mat);
  cornice.position.y = 0.074;
  cornice.castShadow = true;
  piece.add(cornice);

  // Battlements rim
  const rim = new Mesh(new CylinderGeometry(0.024, 0.024, 0.016, 24), mat);
  rim.position.y = 0.086;
  rim.castShadow = true;
  piece.add(rim);

  // Center hollow cutout
  const hollowMat = new MeshStandardMaterial({
    color: color === 'white' ? 0xd1d5db : 0x111827,
    roughness: 0.6,
  });
  const hollow = new Mesh(new CylinderGeometry(0.016, 0.016, 0.010, 16), hollowMat);
  hollow.position.y = 0.090;
  piece.add(hollow);

  return piece;
}

/**
 * 3. Large Knight: Stepped base with bold angular stylized horse head.
 * Height: ~10.5cm | Base Diameter: ~5.4cm
 */
export function createKnight(color: PieceColor): Group {
  const mat = color === 'white' ? whitePieceMaterial : blackPieceMaterial;
  const piece = new Group();
  piece.name = `knight-${color}`;

  const base = createBase(0.026, 0.024, mat);
  piece.add(base);

  // Neck
  const neck = new Mesh(new CylinderGeometry(0.018, 0.021, 0.028, 16), mat);
  neck.position.y = 0.038;
  neck.castShadow = true;
  piece.add(neck);

  // Chest / arched torso
  const chest = new Mesh(new BoxGeometry(0.024, 0.036, 0.030), mat);
  chest.position.set(0, 0.062, 0.004);
  chest.rotation.x = -0.15;
  chest.castShadow = true;
  piece.add(chest);

  // Head and snout
  const head = new Mesh(new BoxGeometry(0.022, 0.024, 0.036), mat);
  head.position.set(0, 0.076, -0.010);
  head.rotation.x = 0.35;
  head.castShadow = true;
  piece.add(head);

  // Left & right pointed ears
  const earGeo = new BoxGeometry(0.005, 0.012, 0.008);
  const leftEar = new Mesh(earGeo, mat);
  leftEar.position.set(-0.008, 0.096, 0.004);
  leftEar.castShadow = true;
  piece.add(leftEar);

  const rightEar = new Mesh(earGeo, mat);
  rightEar.position.set(0.008, 0.096, 0.004);
  rightEar.castShadow = true;
  piece.add(rightEar);

  return piece;
}

/**
 * 4. Large Bishop: Slender fluted column with mitre ellipsoid and bead finial.
 * Height: ~11.5cm | Base Diameter: ~5.4cm
 */
export function createBishop(color: PieceColor): Group {
  const mat = color === 'white' ? whitePieceMaterial : blackPieceMaterial;
  const piece = new Group();
  piece.name = `bishop-${color}`;

  const base = createBase(0.026, 0.024, mat);
  piece.add(base);

  // Body
  const body = new Mesh(new CylinderGeometry(0.015, 0.020, 0.048, 20), mat);
  body.position.y = 0.048;
  body.castShadow = true;
  piece.add(body);

  // Collar
  const collar = new Mesh(new TorusGeometry(0.018, 0.0035, 10, 20), mat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.072;
  collar.castShadow = true;
  piece.add(collar);

  // Mitre ellipsoid head
  const mitreGeo = new SphereGeometry(0.016, 20, 20);
  mitreGeo.scale(1.0, 1.45, 1.0);
  const mitre = new Mesh(mitreGeo, mat);
  mitre.position.y = 0.094;
  mitre.castShadow = true;
  piece.add(mitre);

  // Top finial bead
  const bead = new Mesh(new SphereGeometry(0.005, 16, 16), mat);
  bead.position.y = 0.114;
  bead.castShadow = true;
  piece.add(bead);

  return piece;
}

/**
 * 5. Large Queen: Elegant flaring body with royal coronet.
 * Height: ~12.5cm | Base Diameter: ~5.8cm
 */
export function createQueen(color: PieceColor): Group {
  const mat = color === 'white' ? whitePieceMaterial : blackPieceMaterial;
  const piece = new Group();
  piece.name = `queen-${color}`;

  const base = createBase(0.028, 0.025, mat);
  piece.add(base);

  // Body
  const body = new Mesh(new CylinderGeometry(0.016, 0.022, 0.058, 24), mat);
  body.position.y = 0.054;
  body.castShadow = true;
  piece.add(body);

  // Collar
  const collar = new Mesh(new TorusGeometry(0.020, 0.004, 10, 24), mat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.084;
  collar.castShadow = true;
  piece.add(collar);

  // Coronet crown
  const crown = new Mesh(new CylinderGeometry(0.023, 0.016, 0.024, 24), mat);
  crown.position.y = 0.098;
  crown.castShadow = true;
  piece.add(crown);

  // Top pearl sphere
  const top = new Mesh(new SphereGeometry(0.0075, 18, 18), mat);
  top.position.y = 0.118;
  top.castShadow = true;
  piece.add(top);

  return piece;
}

/**
 * 6. Large King: Tallest piece with broad regal crown and distinct Latin Cross finial.
 * Height: ~13.8cm | Base Diameter: ~6.0cm
 */
export function createKing(color: PieceColor): Group {
  const mat = color === 'white' ? whitePieceMaterial : blackPieceMaterial;
  const piece = new Group();
  piece.name = `king-${color}`;

  const base = createBase(0.030, 0.026, mat);
  piece.add(base);

  // Regal column
  const body = new Mesh(new CylinderGeometry(0.018, 0.024, 0.068, 24), mat);
  body.position.y = 0.060;
  body.castShadow = true;
  piece.add(body);

  // Collar
  const collar = new Mesh(new TorusGeometry(0.022, 0.004, 10, 24), mat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.095;
  collar.castShadow = true;
  piece.add(collar);

  // Crown
  const crown = new Mesh(new CylinderGeometry(0.024, 0.018, 0.022, 24), mat);
  crown.position.y = 0.108;
  crown.castShadow = true;
  piece.add(crown);

  // Latin Cross finial (Vertical)
  const vBar = new Mesh(new BoxGeometry(0.004, 0.018, 0.004), mat);
  vBar.position.y = 0.126;
  vBar.castShadow = true;
  piece.add(vBar);

  // Latin Cross finial (Horizontal)
  const hBar = new Mesh(new BoxGeometry(0.014, 0.004, 0.004), mat);
  hBar.position.y = 0.129;
  hBar.castShadow = true;
  piece.add(hBar);

  return piece;
}

/**
 * Universal piece factory.
 */
export function createPiece(type: PieceType, color: PieceColor): Group {
  switch (type) {
    case 'pawn':
      return createPawn(color);
    case 'rook':
      return createRook(color);
    case 'knight':
      return createKnight(color);
    case 'bishop':
      return createBishop(color);
    case 'queen':
      return createQueen(color);
    case 'king':
      return createKing(color);
  }
}

