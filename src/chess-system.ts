/**
 * Chess System for Hand Chess VR.
 * Coordinates 3D piece transforms, hand-grab lifecycle, move validation,
 * square highlighting, capture mechanics, and spatial UI status.
 *
 * Pinch smoothing: GrabSystem runs first and sets the raw grab position each
 * frame. ChessSystem runs after and applies exponential lerp so the piece
 * glides rather than teleporting with every micro-tremor in the hand.
 * All temporaries are pre-allocated in init() — no allocation in update().
 */

import {
  GrabSystem,
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
import { ChessEngine } from './chess-engine.js';
import { ChessBoard, ChessPiece, ChessTile } from './components.js';
import { chessAudio } from './sound.js';

/** Exponential-smoothing factor for held-piece position (per-frame lerp alpha).
 *  Lower = smoother but laggier; 0.18 is barely perceptible lag at 72 fps. */
const SMOOTH_ALPHA = 0.18;

/** Extra vertical offset so the piece base clears the board surface while held. */
const HOLD_Y_OFFSET = 0.06;

export class ChessSystem extends createSystem({
  pieces: { required: [ChessPiece, OneHandGrabbable] },
  held: { required: [ChessPiece, Grabbed] },
  board: { required: [ChessBoard] },
  tiles: { required: [ChessTile] },
}) {
  private engine = new ChessEngine();
  private activeIndicators: Mesh[] = [];
  private currentLegalMoves: string[] = [];
  private capturedWhiteCount = 0;
  private capturedBlackCount = 0;
  private statusTextElement: any = null;
  private hintTextElement: any = null;

  // Pre-allocated scratch objects — never reassign in update().
  private readonly _smoothTarget = new Vector3();
  private readonly _gripWorldPos = new Vector3();
  private grabSystem: GrabSystem | null = null;

  init(): void {
    // Cache GrabSystem reference — used in update() to identify holder hand.
    // getSystem returns null until systems are registered; it is populated by
    // the time init() runs because World registers all systems before calling init.
    this.grabSystem = this.world.getSystem(GrabSystem) ?? null;

    // 1. Subscribe to piece grab (pinch start)
    const onGrab = (entity: Entity) => this.handlePieceGrabbed(entity);
    // 2. Subscribe to piece release (pinch release)
    const onRelease = (entity: Entity) => this.handlePieceReleased(entity);

    const offGrab = this.queries.held.subscribe('qualify', onGrab);
    const offRelease = this.queries.held.subscribe('disqualify', onRelease);
    this.cleanupFuncs.push(offGrab, offRelease);

    // 3. Connect Spatial UI Panel
    const panel = this.world.getSceneObject<UIKitMLAsset>('chess-panel');
    if (panel) {
      this.statusTextElement = panel.getElementById('turn-text');
      this.hintTextElement = panel.getElementById('hint-text');
      const resetBtn = panel.getElementById('btn-reset');

      if (resetBtn) {
        const onResetClick = () => this.resetGame();
        resetBtn.addEventListener('click', onResetClick);
        this.cleanupFuncs.push(() => resetBtn.removeEventListener('click', onResetClick));
      }
    }
  }

  /**
   * Per-frame pinch-smoothing pass.
   *
   * GrabSystem runs at higher priority and has already moved each held piece
   * to its raw grab target for this frame. We read that raw position, then
   * lerp the mesh toward it with SMOOTH_ALPHA so micro-tremors in the hand
   * pose are damped without introducing noticeable lag.
   *
   * Rules obeyed:
   *   - No allocation: all Vector3 temporaries are class fields (init'd above).
   *   - signal.peek() used instead of .value to avoid per-frame subscriptions.
   */
  update(_delta: number, _time: number): void {
    const heldEntities = this.queries.held.entities;
    if (heldEntities.size === 0) return;

    for (const entity of heldEntities) {
      const mesh = entity.object3D;
      if (!mesh) continue;

      // Identify which hand is holding this piece.
      const hand = this.grabSystem?.getHolderHand(entity) ?? null;
      if (!hand) continue;

      // Get the grip space for the active hand and extract world position.
      // gripSpaces are children of the XROrigin group, so getWorldPosition()
      // accounts for the player's locomotion offset automatically.
      const gripSpace = this.player.gripSpaces[hand];
      gripSpace.getWorldPosition(this._gripWorldPos);

      // Raise target slightly so the piece base doesn't clip the board surface.
      this._gripWorldPos.y += HOLD_Y_OFFSET;

      // Build the smooth target from the grip world position.
      this._smoothTarget.copy(this._gripWorldPos);

      // Exponential lerp: mesh position moves SMOOTH_ALPHA of the way toward
      // the target each frame. At 72 fps and alpha=0.18 this is ~90 ms of lag,
      // which is enough to visually eliminate tremor without feeling sticky.
      mesh.position.lerp(this._smoothTarget, SMOOTH_ALPHA);
    }
  }

  private handlePieceGrabbed(entity: Entity): void {
    const square = entity.getValue(ChessPiece, 'square') || '';
    const color = entity.getValue(ChessPiece, 'color') || 'white';

    if (!square) return;

    // Only allow interacting with pieces belonging to the current player's turn
    if (color !== this.engine.turn) {
      this.currentLegalMoves = [];
      return;
    }

    chessAudio.playPick();

    // Query legal destination squares
    this.currentLegalMoves = this.engine.getLegalMoves(square);
    this.showDestinationIndicators(this.currentLegalMoves);

    if (this.hintTextElement) {
      const pType = entity.getValue(ChessPiece, 'type') || 'piece';
      this.hintTextElement.setProperties({
        text: `Moving ${color} ${pType} from ${square.toUpperCase()}`,
      });
    }
  }

  private handlePieceReleased(entity: Entity): void {
    this.clearDestinationIndicators();

    const currentSq = entity.getValue(ChessPiece, 'square') || '';
    const originalSq = entity.getValue(ChessPiece, 'originalSquare') || currentSq;
    const color = entity.getValue(ChessPiece, 'color') || 'white';

    if (!currentSq || !originalSq) return;

    if (color !== this.engine.turn) {
      this.snapPieceToSquare(entity, originalSq);
      return;
    }

    const mesh = entity.object3D;
    if (!mesh) {
      this.snapPieceToSquare(entity, originalSq);
      return;
    }

    // Determine target square on board closest to release position
    const targetSq = worldPositionToSquare(mesh.position);

    if (targetSq && this.currentLegalMoves.includes(targetSq)) {
      // Execute move in chess engine
      const moveResult = this.engine.makeMove(currentSq, targetSq);

      if (moveResult.valid) {
        // If an opponent piece was captured, relocate it to the capture tray
        if (moveResult.capturedPiece) {
          this.handleCapture(moveResult.capturedPiece.square, moveResult.capturedPiece.color);
          chessAudio.playCapture();
        } else {
          chessAudio.playDrop();
        }

        // Snap moved piece to target square center
        this.snapPieceToSquare(entity, targetSq);
        entity.setValue(ChessPiece, 'square', targetSq);
        entity.setValue(ChessPiece, 'originalSquare', targetSq);

        // Update UI
        this.updateGameStatus(moveResult);
        return;
      }
    }

    // Move is invalid or piece released off-board -> snap back
    chessAudio.playInvalid();
    this.snapPieceToSquare(entity, originalSq);
  }

  public snapPieceToSquare(entity: Entity, square: string): void {
    const mesh = entity.object3D;
    if (!mesh || !square) return;

    const targetPos = squareToWorldPosition(square);
    mesh.position.copy(targetPos);
    mesh.rotation.set(0, 0, 0);
  }

  private handleCapture(square: string, capturedColor: string): void {
    for (const entity of this.queries.pieces.entities) {
      const sq = entity.getValue(ChessPiece, 'square');
      const isCap = entity.getValue(ChessPiece, 'isCaptured');

      if (sq === square && !isCap) {
        entity.setValue(ChessPiece, 'isCaptured', true);
        const mesh = entity.object3D;
        if (!mesh) continue;

        // Position in capture tray
        if (capturedColor === 'white') {
          const index = this.capturedWhiteCount++;
          const zOffset = -0.24 + (index % 8) * 0.07;
          const xOffset = index >= 8 ? -0.52 : -0.44;
          mesh.position.set(BOARD_POSITION.x + xOffset, BOARD_POSITION.y + 0.04, BOARD_POSITION.z + zOffset);
        } else {
          const index = this.capturedBlackCount++;
          const zOffset = -0.24 + (index % 8) * 0.07;
          const xOffset = index >= 8 ? 0.52 : 0.44;
          mesh.position.set(BOARD_POSITION.x + xOffset, BOARD_POSITION.y + 0.04, BOARD_POSITION.z + zOffset);
        }
        mesh.rotation.set(0, 0, 0);
        break;
      }
    }
  }

  private showDestinationIndicators(squares: string[]): void {
    this.clearDestinationIndicators();

    for (const sq of squares) {
      const occupant = this.engine.getPiece(sq);
      const isCapture = occupant != null;
      const indicator = createHighlightMarker(isCapture ? 'capture' : 'move');

      const worldPos = squareToWorldPosition(sq);
      indicator.position.set(worldPos.x, worldPos.y + 0.003, worldPos.z);

      this.world.scene.add(indicator);
      this.activeIndicators.push(indicator);
    }
  }

  private clearDestinationIndicators(): void {
    for (const indicator of this.activeIndicators) {
      this.world.scene.remove(indicator);
      indicator.geometry.dispose();
    }
    this.activeIndicators = [];
  }

  private updateGameStatus(result: { isCheck: boolean; isCheckmate: boolean; isStalemate: boolean; turn: string }): void {
    if (!this.statusTextElement) return;

    if (result.isCheckmate) {
      const winner = result.turn === 'white' ? 'Black' : 'White';
      this.statusTextElement.setProperties({ text: `CHECKMATE! ${winner} Wins!` });
      if (this.hintTextElement) {
        this.hintTextElement.setProperties({ text: 'Tap "New Game" on panel to restart.' });
      }
      chessAudio.playCheck();
    } else if (result.isCheck) {
      const checkedColor = result.turn === 'white' ? 'White' : 'Black';
      this.statusTextElement.setProperties({ text: `${checkedColor} is in CHECK!` });
      chessAudio.playCheck();
    } else if (result.isStalemate) {
      this.statusTextElement.setProperties({ text: 'STALEMATE! Draw.' });
    } else {
      const turnName = result.turn === 'white' ? 'White' : 'Black';
      this.statusTextElement.setProperties({ text: `${turnName} to move` });
      if (this.hintTextElement) {
        this.hintTextElement.setProperties({ text: 'Pinch piece with thumb & index finger to lift' });
      }
    }
  }

  public resetGame(): void {
    this.engine.reset();
    this.clearDestinationIndicators();
    this.capturedWhiteCount = 0;
    this.capturedBlackCount = 0;

    // Reset all piece entities to initial squares
    for (const entity of this.queries.pieces.entities) {
      const originalSq = entity.getValue(ChessPiece, 'originalSquare');
      if (originalSq) {
        entity.setValue(ChessPiece, 'square', originalSq);
        entity.setValue(ChessPiece, 'isCaptured', false);
        this.snapPieceToSquare(entity, originalSq);
      }
    }

    if (this.statusTextElement) {
      this.statusTextElement.setProperties({ text: 'White to move' });
    }
    if (this.hintTextElement) {
      this.hintTextElement.setProperties({ text: 'Pinch piece with thumb & index finger to lift' });
    }

    chessAudio.playDrop();
  }
}
