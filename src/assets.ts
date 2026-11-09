/**
 * Asset manifest for Hand Chess VR.
 * Evaluated independently by runtime and editor: deterministic, no DOM/World access.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import { createFloatingBoard, createHighlightMarker } from './board.js';
import {
  createBishop,
  createKing,
  createKnight,
  createPawn,
  createQueen,
  createRook,
} from './pieces.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

const uikitml = (fileName: string, name: string) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

export default defineAssets({
  'chess-board': createFloatingBoard(),
  'pawn-white': createPawn('white'),
  'pawn-black': createPawn('black'),
  'rook-white': createRook('white'),
  'rook-black': createRook('black'),
  'knight-white': createKnight('white'),
  'knight-black': createKnight('black'),
  'bishop-white': createBishop('white'),
  'bishop-black': createBishop('black'),
  'queen-white': createQueen('white'),
  'queen-black': createQueen('black'),
  'king-white': createKing('white'),
  'king-black': createKing('black'),
  'tile-indicator-move': createHighlightMarker('move'),
  'tile-indicator-capture': createHighlightMarker('capture'),
  'chess-panel': uikitml('chess-panel.uikitml', 'Chess Control Panel'),
});
