/**
 * Chess System for Hand Chess VR.
 *
 * Uses chess.js for authoritative rule enforcement:
 *   - Only legal moves are accepted; illegal drops snap the piece back.
 *   - Turns, captures (piece relocated to tray), check, checkmate, and all
 *     draw conditions (stalemate, insufficient material, 50-move rule,
 *     threefold repetition) are all handled by chess.js.
 *
 * Pinch smoothing: GrabSystem runs first each frame and sets the raw grab
 * position. ChessSystem then lerps the mesh toward the grip-space world
 * position with exponential smoothing (alpha 0.18) so hand tremor is damped.
 * All Vector3 temporaries are pre-allocated in init() — no heap allocation
 * in update().
 */

import { Chess } from 'chess.js';
import type { Move, Square } from 'chess.js';
import {
  GrabSystem,
  MeshPhysicalMaterial,
  Object3D,
  createSystem,
  Entity,
  Grabbed,
  Mesh,
  OneHandGrabbable,
  UIKitMLAsset,
  Vector3,
} from '@iwsdk/core';
import {
  BOARD_POSITION,
  createHighlightMarker,
  squareToWorldPosition,
  worldPositionToSquare,
} from './board.js';
import { ChessBoard, ChessPiece, ChessTile } from './components.js';
import { chessAudio } from './sound.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Exponential-smoothing factor per frame (alpha). 0.18 at 72 fps ≈ 90 ms lag. */
const SMOOTH_ALPHA = 0.18;

/** Vertical lift so the held piece base clears the board surface. */
const HOLD_Y_OFFSET = 0.06;

/** Distance (m) at which a hand index-tip triggers hover glow. */
const HOVER_RADIUS = 0.085;

/** Hover emissive hex: amber for white-side pieces, cyan for black-side. */
const HOVER_EMISSIVE_WHITE = 0xffaa44;
const HOVER_EMISSIVE_BLACK = 0x44ddff;
const HOVER_INTENSITY = 0.35;

// ---------------------------------------------------------------------------
// Helpers (pure functions, called at event-time not in the hot update loop)
// ---------------------------------------------------------------------------

/** Clone materials on every mesh under `obj` so emissive changes are per-piece. */
function isolateMaterials(obj: Object3D): void {
  obj.traverse((child) => {
    if (child instanceof Mesh && child.material instanceof MeshPhysicalMaterial) {
      child.material = child.material.clone();
    }
  });
}

/** Set or clear hover-glow emissive on all MeshPhysicalMaterial children. */
function setHoverGlow(obj: Object3D, on: boolean, emissiveHex: number): void {
  obj.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const mat = child.material;
    if (!(mat instanceof MeshPhysicalMaterial)) return;
    mat.emissive.setHex(on ? emissiveHex : 0x000000);
    mat.emissiveIntensity = on ? HOVER_INTENSITY : 0;
  });
}

/** chess.js turn letter → full color string. */
function turnColor(chess: Chess): 'white' | 'black' {
  return chess.turn() === 'w' ? 'white' : 'black';
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export class ChessSystem extends createSystem({
  pieces: { required: [ChessPiece, OneHandGrabbable] },
  held:   { required: [ChessPiece, Grabbed] },
  board:  { required: [ChessBoard] },
  tiles:  { required: [ChessTile] },
}) {
  // chess.js instance — single source of truth for all board state.
  private chess = new Chess();

  // Visual state
  private activeIndicators: Mesh[] = [];

  // Legal destination squares for the piece currently being dragged.
  // Set on grab, cleared on release.
  private currentLegalSquares: string[] = [];

  // Capture-tray counters (how many pieces are already in each tray).
  private capturedWhiteCount = 0;
  private capturedBlackCount = 0;

  // UIKitML element references (populated in init).
  private statusEl: any = null;
  private hintEl: any = null;

  // Game-over flag: once true, all grabs are ignored until resetGame().
  private gameOver = false;

  // ----- Pre-allocated temporaries (never re-created in update) -----
  private readonly _gripWorldPos  = new Vector3();
  private readonly _smoothTarget  = new Vector3();
  private readonly _pieceWorldPos = new Vector3();
  private readonly _tipLeft       = new Vector3();
  private readonly _tipRight      = new Vector3();

  private grabSystem: GrabSystem | null = null;
  private _hoveredEntity: Entity | null = null;

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  init(): void {
    this.grabSystem = this.world.getSystem(GrabSystem) ?? null;

    // Clone materials so each piece can glow independently.
    for (const entity of this.queries.pieces.entities) {
      const mesh = entity.object3D;
      if (mesh) isolateMaterials(mesh);
    }

    // ECS grab lifecycle events.
    const offGrab    = this.queries.held.subscribe('qualify',    (e) => this.onGrab(e));
    const offRelease = this.queries.held.subscribe('disqualify', (e) => this.onRelease(e));
    this.cleanupFuncs.push(offGrab, offRelease);

    // Spatial UI panel.
    const panel = this.world.getSceneObject<UIKitMLAsset>('chess-panel');
    if (panel) {
      this.statusEl = panel.getElementById('turn-text');
      this.hintEl   = panel.getElementById('hint-text');
      const resetBtn = panel.getElementById('btn-reset');
      if (resetBtn) {
        const cb = () => this.resetGame();
        resetBtn.addEventListener('click', cb);
        this.cleanupFuncs.push(() => resetBtn.removeEventListener('click', cb));
      }
    }

    this.refreshStatusUI();
  }

  // -------------------------------------------------------------------------
  // update — runs every frame, 72–90 fps.  NO allocation allowed here.
  // -------------------------------------------------------------------------

  update(_delta: number, _time: number): void {
    this.updateSmoothing();
    this.updateHoverGlow();
  }

  /** Lerp held-piece positions toward the hand grip (pinch smoothing). */
  private updateSmoothing(): void {
    if (this.queries.held.entities.size === 0) return;

    for (const entity of this.queries.held.entities) {
      const mesh = entity.object3D;
      if (!mesh) continue;

      const hand = this.grabSystem?.getHolderHand(entity) ?? null;
      if (!hand) continue;

      this.player.gripSpaces[hand].getWorldPosition(this._gripWorldPos);
      this._gripWorldPos.y += HOLD_Y_OFFSET;
      this._smoothTarget.copy(this._gripWorldPos);
      mesh.position.lerp(this._smoothTarget, SMOOTH_ALPHA);
    }
  }

  /** Hover glow — highlights the piece whose center is closest to either
   * index-tip space and within HOVER_RADIUS.  Only one piece glows at a time;
   * the previous one is cleared before the new one is lit.
   */
  private updateHoverGlow(): void {
    // Don't show hover on a piece that is already being held.
    const heldSet = this.queries.held.entities;

    this.player.indexTipSpaces.left.getWorldPosition(this._tipLeft);
    this.player.indexTipSpaces.right.getWorldPosition(this._tipRight);

    let closest: Entity | null = null;
    let closestDist = HOVER_RADIUS;

    for (const entity of this.queries.pieces.entities) {
      if (heldSet.has(entity)) continue;
      if (entity.getValue(ChessPiece, 'isCaptured')) continue;

      const mesh = entity.object3D;
      if (!mesh) continue;

      mesh.getWorldPosition(this._pieceWorldPos);
      const dl = this._pieceWorldPos.distanceTo(this._tipLeft);
      const dr = this._pieceWorldPos.distanceTo(this._tipRight);
      const d = Math.min(dl, dr);

      if (d < closestDist) {
        closestDist = d;
        closest = entity;
      }
    }

    if (closest !== this._hoveredEntity) {
      // Clear old glow.
      if (this._hoveredEntity) {
        const prevMesh = this._hoveredEntity.object3D;
        if (prevMesh) setHoverGlow(prevMesh, false, 0);
      }
      // Apply new glow.
      if (closest) {
        const color = closest.getValue(ChessPiece, 'color') || 'white';
        const emissive = color === 'white' ? HOVER_EMISSIVE_WHITE : HOVER_EMISSIVE_BLACK;
        const mesh = closest.object3D;
        if (mesh) setHoverGlow(mesh, true, emissive);
      }
      this._hoveredEntity = closest;
    }
  }

  // -------------------------------------------------------------------------
  // Grab events
  // -------------------------------------------------------------------------

  private onGrab(entity: Entity): void {
    if (this.gameOver) {
      // Drop it immediately — game is over.
      this.grabSystem?.forceRelease(entity);
      return;
    }

    const square = entity.getValue(ChessPiece, 'square') || '';
    const color  = entity.getValue(ChessPiece, 'color')  || 'white';
    if (!square) return;

    // Wrong turn — force-release with feedback.
    if (color !== turnColor(this.chess)) {
      this.grabSystem?.forceRelease(entity);
      chessAudio.playInvalid();
      if (this.hintEl) {
        const whose = turnColor(this.chess);
        this.hintEl.setProperties({ text: `It is ${whose}'s turn` });
      }
      return;
    }

    chessAudio.playPick();

    // Compute legal destinations from chess.js (verbose = includes capture flag).
    const moves = this.chess.moves({ square: square as Square, verbose: true });
    this.currentLegalSquares = moves.map((m) => m.to);
    this.showIndicators(moves);

    if (this.hintEl) {
      const pType = entity.getValue(ChessPiece, 'type') || 'piece';
      this.hintEl.setProperties({ text: `Moving ${color} ${pType} from ${square.toUpperCase()}` });
    }
  }

  private onRelease(entity: Entity): void {
    this.clearIndicators();

    const fromSq = entity.getValue(ChessPiece, 'square') || '';
    if (!fromSq) return;

    const mesh = entity.object3D;
    if (!mesh) {
      this.snapToSquare(entity, fromSq);
      return;
    }

    const toSq = worldPositionToSquare(mesh.position);

    // Attempt the move through chess.js — it throws if illegal.
    if (toSq && this.currentLegalSquares.includes(toSq)) {
      let moveResult: ReturnType<Chess['move']> | null = null;
      try {
        // Always promote to queen for pawn promotion.
        moveResult = this.chess.move({ from: fromSq, to: toSq, promotion: 'q' });
      } catch {
        moveResult = null;
      }

      if (moveResult) {
        // Handle capture: find the entity on the destination square and tray it.
        if (moveResult.captured) {
          // For en passant the captured pawn is not on `toSq` but one rank behind.
          const capturedSq = moveResult.flags.includes('e')
            ? toSq[0] + fromSq[1]   // en-passant captured pawn square
            : toSq;
          const capturedColor = moveResult.color === 'w' ? 'black' : 'white';
          this.relocateCapturedPiece(capturedSq, capturedColor);
          chessAudio.playCapture();
        } else {
          chessAudio.playDrop();
        }

        // Snap moved piece to target square center, update ECS component.
        this.snapToSquare(entity, toSq);
        entity.setValue(ChessPiece, 'square', toSq);
        entity.setValue(ChessPiece, 'originalSquare', toSq);

        this.checkGameEnd();
        this.refreshStatusUI();
        this.currentLegalSquares = [];
        return;
      }
    }

    // Illegal drop (off-board, wrong square, or chess.js rejected it).
    chessAudio.playInvalid();
    this.snapToSquare(entity, fromSq);
    this.currentLegalSquares = [];
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  public snapToSquare(entity: Entity, square: string): void {
    const mesh = entity.object3D;
    if (!mesh || !square) return;
    mesh.position.copy(squareToWorldPosition(square));
    mesh.rotation.set(0, 0, 0);
  }

  /** Move the captured piece's 3-D mesh to the capture tray. */
  private relocateCapturedPiece(square: string, capturedColor: 'white' | 'black'): void {
    for (const entity of this.queries.pieces.entities) {
      const sq  = entity.getValue(ChessPiece, 'square');
      const cap = entity.getValue(ChessPiece, 'isCaptured');
      if (sq !== square || cap) continue;

      entity.setValue(ChessPiece, 'isCaptured', true);
      const mesh = entity.object3D;
      if (!mesh) break;

      if (capturedColor === 'white') {
        const idx = this.capturedWhiteCount++;
        const z = -0.24 + (idx % 8) * 0.07;
        const x = idx >= 8 ? -0.52 : -0.44;
        mesh.position.set(BOARD_POSITION.x + x, BOARD_POSITION.y + 0.04, BOARD_POSITION.z + z);
      } else {
        const idx = this.capturedBlackCount++;
        const z = -0.24 + (idx % 8) * 0.07;
        const x = idx >= 8 ? 0.52 : 0.44;
        mesh.position.set(BOARD_POSITION.x + x, BOARD_POSITION.y + 0.04, BOARD_POSITION.z + z);
      }
      mesh.rotation.set(0, 0, 0);
      break;
    }
  }

  // -------------------------------------------------------------------------
  // Visual indicators
  // -------------------------------------------------------------------------

  private showIndicators(moves: Move[]): void {
    this.clearIndicators();
    for (const m of moves) {
      const isCapture = m.captured !== undefined;
      const sq = m.to;
      if (!sq) continue;
      const indicator = createHighlightMarker(isCapture ? 'capture' : 'move');
      const worldPos = squareToWorldPosition(sq);
      indicator.position.set(worldPos.x, worldPos.y + 0.003, worldPos.z);
      this.world.scene.add(indicator);
      this.activeIndicators.push(indicator);
    }
  }

  private clearIndicators(): void {
    for (const ind of this.activeIndicators) {
      this.world.scene.remove(ind);
      ind.geometry.dispose();
    }
    this.activeIndicators = [];
  }

  // -------------------------------------------------------------------------
  // Game-state: check / checkmate / draw
  // -------------------------------------------------------------------------

  /** Called after each successful move. Sets gameOver and plays audio. */
  private checkGameEnd(): void {
    if (this.chess.isCheckmate() || this.chess.isDraw()) {
      this.gameOver = true;
      chessAudio.playCheck();
    } else if (this.chess.inCheck()) {
      chessAudio.playCheck();
    }
  }

  private refreshStatusUI(): void {
    if (!this.statusEl) return;
    const whose = turnColor(this.chess);

    if (this.chess.isCheckmate()) {
      const winner = whose === 'white' ? 'Black' : 'White';
      this.statusEl.setProperties({ text: `CHECKMATE! ${winner} wins!` });
      this.hintEl?.setProperties({ text: 'Tap "New Game" to play again.' });
    } else if (this.chess.isStalemate()) {
      this.statusEl.setProperties({ text: 'STALEMATE - Draw!' });
      this.hintEl?.setProperties({ text: 'Tap "New Game" to play again.' });
    } else if (this.chess.isInsufficientMaterial()) {
      this.statusEl.setProperties({ text: 'Draw - Insufficient material' });
      this.hintEl?.setProperties({ text: 'Tap "New Game" to play again.' });
    } else if (this.chess.isThreefoldRepetition()) {
      this.statusEl.setProperties({ text: 'Draw - Threefold repetition' });
      this.hintEl?.setProperties({ text: 'Tap "New Game" to play again.' });
    } else if (this.chess.isDraw()) {
      this.statusEl.setProperties({ text: 'Draw!' });
      this.hintEl?.setProperties({ text: 'Tap "New Game" to play again.' });
    } else if (this.chess.inCheck()) {
      this.statusEl.setProperties({ text: `${whose.charAt(0).toUpperCase() + whose.slice(1)} is in CHECK!` });
      this.hintEl?.setProperties({ text: 'Your king is in check - you must move out.' });
    } else {
      const label = whose.charAt(0).toUpperCase() + whose.slice(1);
      this.statusEl.setProperties({ text: `${label} to move` });
      this.hintEl?.setProperties({ text: 'Pinch piece with thumb & index finger to lift' });
    }
  }

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  public resetGame(): void {
    this.chess.reset();
    this.gameOver = false;
    this.clearIndicators();
    this.currentLegalSquares = [];
    this.capturedWhiteCount = 0;
    this.capturedBlackCount = 0;
    this._hoveredEntity = null;

    for (const entity of this.queries.pieces.entities) {
      const originalSq = entity.getValue(ChessPiece, 'originalSquare');
      if (!originalSq) continue;
      entity.setValue(ChessPiece, 'square', originalSq);
      entity.setValue(ChessPiece, 'isCaptured', false);
      this.snapToSquare(entity, originalSq);
    }

    this.refreshStatusUI();
    chessAudio.playDrop();
  }
}
