/**
 * Board module for Hand Chess VR.
 * Defines the 8x8 floating chessboard, square coordinate conversions,
 * materials, and visual destination indicators.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';

// Floating board position: 0.8m in front of seated user at chest/lap height
export const BOARD_POSITION = new Vector3(0, 0.85, -0.80);
export const SQUARE_SIZE = 0.08; // 8cm squares for large hand-grabbable pieces
export const BOARD_SURFACE_Y = 0.022; // Height above board origin to tile surface

// High-contrast materials for clear visibility in VR
export const boardFrameMaterial = new MeshStandardMaterial({
  color: 0x1e2024, // Modern obsidian dark matte slab
  roughness: 0.4,
  metalness: 0.1,
});

export const boardTrimMaterial = new MeshStandardMaterial({
  color: 0x3b82f6, // Subtle glowing blue accent trim
  emissive: 0x1d4ed8,
  emissiveIntensity: 0.35,
  roughness: 0.3,
  metalness: 0.2,
});

export const lightSquareMaterial = new MeshStandardMaterial({
  color: 0xf1f5f9, // Crisp clean slate-white
  roughness: 0.3,
  metalness: 0.05,
});

export const darkSquareMaterial = new MeshStandardMaterial({
  color: 0x334155, // Deep slate charcoal
  roughness: 0.35,
  metalness: 0.05,
});

export const trayMaterial = new MeshStandardMaterial({
  color: 0x0f172a, // Recessed capture tray
  roughness: 0.5,
  metalness: 0.1,
});

export const indicatorMoveMaterial = new MeshStandardMaterial({
  color: 0x22c55e, // Emerald green for legal destination
  emissive: 0x15803d,
  emissiveIntensity: 0.7,
  roughness: 0.2,
  transparent: true,
  opacity: 0.7,
});

export const indicatorCaptureMaterial = new MeshStandardMaterial({
  color: 0xef4444, // Red for legal capture square
  emissive: 0xb91c1c,
  emissiveIntensity: 0.8,
  roughness: 0.2,
  transparent: true,
  opacity: 0.75,
});

/**
 * Creates the 8x8 floating chessboard with side capture trays and glowing accents.
 * Origin (0,0,0) is at the center bottom of the floating slab.
 */
export function createFloatingBoard(): Group {
  const board = new Group();
  board.name = 'floating-chess-board';

  // 1. Floating main slab (0.72m x 0.036m x 0.72m)
  const frameGeo = new BoxGeometry(0.72, 0.036, 0.72);
  const frameMesh = new Mesh(frameGeo, boardFrameMaterial);
  frameMesh.position.y = 0.018;
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;
  board.add(frameMesh);

  // 2. Beveled neon edge trim outlining the board
  const trimGeo = new BoxGeometry(0.73, 0.008, 0.73);
  const trimMesh = new Mesh(trimGeo, boardTrimMaterial);
  trimMesh.position.y = 0.034;
  board.add(trimMesh);

  // 3. 64 Individual tiles (8x8, each 8cm x 8cm)
  const tileGeo = new BoxGeometry(SQUARE_SIZE * 0.985, 0.006, SQUARE_SIZE * 0.985);

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const isLight = (rank + file) % 2 === 1;
      const mat = isLight ? lightSquareMaterial : darkSquareMaterial;
      const tile = new Mesh(tileGeo, mat);

      // file 0..7 -> x = -0.28 to +0.28; rank 0..7 -> z = +0.28 to -0.28
      tile.position.x = (file - 3.5) * SQUARE_SIZE;
      tile.position.y = 0.036 + 0.003;
      tile.position.z = (3.5 - rank) * SQUARE_SIZE;
      tile.receiveShadow = true;

      const fileChar = String.fromCharCode('a'.charCodeAt(0) + file);
      const rankNum = rank + 1;
      tile.name = `square-${fileChar}${rankNum}`;

      board.add(tile);
    }
  }

  // 4. Floating Left Tray (for White's captured pieces)
  const trayGeo = new BoxGeometry(0.18, 0.026, 0.68);
  const leftTray = new Mesh(trayGeo, trayMaterial);
  leftTray.position.set(-0.48, 0.013, 0);
  leftTray.castShadow = true;
  leftTray.receiveShadow = true;
  leftTray.name = 'tray-white-captured';
  board.add(leftTray);

  // 5. Floating Right Tray (for Black's captured pieces)
  const rightTray = new Mesh(trayGeo, trayMaterial);
  rightTray.position.set(0.48, 0.013, 0);
  rightTray.castShadow = true;
  rightTray.receiveShadow = true;
  rightTray.name = 'tray-black-captured';
  board.add(rightTray);

  return board;
}

/**
 * Converts algebraic coordinate (e.g. "e4") to local position relative to board origin.
 */
export function squareToLocalPosition(square: string): Vector3 {
  const file = square.toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0); // 0..7
  const rank = parseInt(square[1], 10) - 1; // 0..7
  const x = (file - 3.5) * SQUARE_SIZE;
  const z = (3.5 - rank) * SQUARE_SIZE;
  const y = 0.036 + 0.006; // On top of tile surface
  return new Vector3(x, y, z);
}

/**
 * Converts algebraic coordinate (e.g. "e4") to world space position.
 */
export function squareToWorldPosition(square: string): Vector3 {
  const local = squareToLocalPosition(square);
  return local.add(BOARD_POSITION);
}

/**
 * Converts world space position into nearest algebraic coordinate.
 */
export function worldPositionToSquare(worldPos: Vector3): string | null {
  const relX = worldPos.x - BOARD_POSITION.x;
  const relZ = worldPos.z - BOARD_POSITION.z;

  const fileIdx = Math.round(relX / SQUARE_SIZE + 3.5);
  const rankIdx = Math.round(3.5 - relZ / SQUARE_SIZE);

  if (fileIdx < 0 || fileIdx > 7 || rankIdx < 0 || rankIdx > 7) {
    return null;
  }

  const fileChar = String.fromCharCode('a'.charCodeAt(0) + fileIdx);
  const rankNum = rankIdx + 1;
  const sq = `${fileChar}${rankNum}`;

  // Verify distance is within snap tolerance
  const sqWorld = squareToWorldPosition(sq);
  const distSq = sqWorld.distanceToSquared(worldPos);
  if (distSq < (SQUARE_SIZE * 0.85) * (SQUARE_SIZE * 0.85)) {
    return sq;
  }

  return null;
}

/**
 * Creates visual destination indicator mesh.
 * - Move: Circular glowing disc for empty landing squares.
 * - Capture: Glowing outer ring that encircles enemy pieces without clipping.
 */
export function createHighlightMarker(type: 'move' | 'capture' = 'move'): Mesh {
  if (type === 'capture') {
    const geo = new TorusGeometry(0.035, 0.0035, 10, 24);
    const mesh = new Mesh(geo, indicatorCaptureMaterial);
    mesh.rotation.x = Math.PI / 2;
    mesh.name = 'highlight-capture';
    return mesh;
  }

  const geo = new CylinderGeometry(0.024, 0.024, 0.004, 24);
  const mesh = new Mesh(geo, indicatorMoveMaterial);
  mesh.name = 'highlight-move';
  return mesh;
}

