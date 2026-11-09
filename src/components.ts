/**
 * Component catalog for Hand Chess VR.
 * Declared in a system-free module and exported via defineComponents().
 */

import { createComponent, defineComponents, Types } from '@iwsdk/core';

export const ChessPiece = createComponent('ChessPiece', {
  pieceId: { type: Types.String, default: '' },
  type: { type: Types.String, default: 'pawn' },
  color: { type: Types.String, default: 'white' },
  square: { type: Types.String, default: '' },
  originalSquare: { type: Types.String, default: '' },
  isCaptured: { type: Types.Boolean, default: false },
});

export const ChessBoard = createComponent('ChessBoard', {
  turn: { type: Types.String, default: 'white' },
  status: { type: Types.String, default: 'in_progress' },
  selectedSquare: { type: Types.String, default: '' },
});

export const ChessTile = createComponent('ChessTile', {
  square: { type: Types.String, default: '' },
  isHighlighted: { type: Types.Boolean, default: false },
});

export default defineComponents([ChessPiece, ChessBoard, ChessTile]);
