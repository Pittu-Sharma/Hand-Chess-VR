/**
 * Chess System for Hand Chess VR.
 *
 * Uses chess.js for authoritative rule enforcement and Stockfish 19
 * (running in a background Web Worker) as the Black opponent.
 *
 * Features:
 *   - Seated Quest hands-only experience (no controllers).
 *   - Start screen with how-to-play tips and difficulty selector.
 *   - High-visibility legal square indicators when a piece is grabbed:
 *     glowing emerald discs for legal moves, glowing ruby rings for captures.
 *   - Rich procedural spatial audio (piece pick, move drop, piece capture,
 *     check alarm, game start chime, victory fanfare, defeat progression).
 *   - Floating Win / Lose / Draw panel with game stats and a pinch-to-restart button.
 *   - Stockfish AI plays Black automatically with 3D arc piece animation.
 *   - Zero heap allocation in update(): pre-allocated Vector3 scratch objects.
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
  Raycaster,
  UIKitMLAsset,
  Vector2,
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
import { StockfishService } from './stockfish-service.js';
import type { Difficulty, StockfishMove } from './stockfish-service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Exponential-smoothing factor per frame (alpha). 0.18 at 72 fps ≈ 90 ms lag. */
const SMOOTH_ALPHA = 0.18;

/** Vertical lift so the held piece base clears the board surface. */
const HOLD_Y_OFFSET = 0.06;

/** Distance (m) at which a hand index-tip triggers hover glow. */
const HOVER_RADIUS = 0.085;

/** Hover emissive hex: amber for white-side pieces. */
const HOVER_EMISSIVE_WHITE = 0xffaa44;
const HOVER_INTENSITY = 0.35;

/** AI piece travel animation duration in seconds. */
const AI_ANIM_DURATION = 0.65;

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

/** Toggle UI component visibility and layout inclusion. */
function setViewVisible(el: any, visible: boolean): void {
  if (!el) return;
  if (typeof el.setProperties === 'function') {
    el.setProperties({ display: visible ? 'flex' : 'none' });
  }
  el.visible = visible;
  if (typeof el.traverse === 'function') {
    el.traverse((c: any) => {
      c.visible = visible;
    });
  }
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

  // Stockfish 19 AI engine in Web Worker
  private stockfish = new StockfishService('easy');

  // Visual state
  private activeIndicators: Mesh[] = [];

  // Legal destination squares for the piece currently being dragged.
  private currentLegalSquares: string[] = [];

  // Capture-tray counters
  private capturedWhiteCount = 0;
  private capturedBlackCount = 0;
  private moveCount = 0;

  // UIKitML element references
  private viewStartEl: any = null;
  private viewPlayingEl: any = null;
  private viewGameOverEl: any = null;

  private statusEl: any = null;
  private hintEl: any = null;
  private diffLabelEl: any = null;
  private startDiffLabelEl: any = null;

  private gameOverEyebrowEl: any = null;
  private gameOverTitleEl: any = null;
  private gameOverDetailEl: any = null;
  private gameOverStatsEl: any = null;

  // Game state flags
  private gameStarted = false;
  private gameOver = false;
  private isAiThinking = false;
  private isAiAnimating = false;

  // AI piece movement animation state
  private aiAnimEntity: Entity | null = null;
  private aiAnimFromSq = '';
  private aiAnimToSq = '';
  private aiAnimPromotion?: string;
  private aiAnimElapsed = 0;

  // ----- Pre-allocated temporaries (never re-created in update) -----
  private readonly _gripWorldPos  = new Vector3();
  private readonly _smoothTarget  = new Vector3();
  private readonly _pieceWorldPos = new Vector3();
  private readonly _tipLeft       = new Vector3();
  private readonly _tipRight      = new Vector3();
  private readonly _aiStartPos    = new Vector3();
  private readonly _aiEndPos      = new Vector3();

  private grabSystem: GrabSystem | null = null;
  private _hoveredEntity: Entity | null = null;

  // Mouse interaction state (desktop browser)
  private mouseSelectedEntity: Entity | null = null;
  private readonly _raycaster = new Raycaster();
  private readonly _mouseCoords = new Vector2();
  private _isOrbiting = false;
  private _pointerDownX = 0;
  private _pointerDownY = 0;
  private _lastPointerX = 0;
  private _lastPointerY = 0;
  private _cameraTheta = 0;
  private _cameraPhi = 0.85;
  private _cameraRadius = 0.88;
  private readonly _boardCenter = new Vector3(0, 0.85, -0.80);

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
      this.viewStartEl = panel.getElementById('view-start');
      this.viewPlayingEl = panel.getElementById('view-playing');
      this.viewGameOverEl = panel.getElementById('view-gameover');

      this.statusEl = panel.getElementById('turn-text');
      this.hintEl   = panel.getElementById('hint-text');
      this.diffLabelEl = panel.getElementById('difficulty-label');
      this.startDiffLabelEl = panel.getElementById('start-diff-label');

      this.gameOverEyebrowEl = panel.getElementById('gameover-eyebrow');
      this.gameOverTitleEl = panel.getElementById('gameover-title');
      this.gameOverDetailEl = panel.getElementById('gameover-detail');
      this.gameOverStatsEl = panel.getElementById('gameover-stats');

      // Start screen buttons
      const startGameBtn = panel.getElementById('btn-start-game');
      if (startGameBtn) {
        const onStart = () => this.startGame();
        startGameBtn.addEventListener('click', onStart);
        this.cleanupFuncs.push(() => startGameBtn.removeEventListener('click', onStart));
      }

      const startDiffBtn = panel.getElementById('btn-start-diff');
      if (startDiffBtn) {
        const onStartDiff = () => this.toggleDifficulty();
        startDiffBtn.addEventListener('click', onStartDiff);
        this.cleanupFuncs.push(() => startDiffBtn.removeEventListener('click', onStartDiff));
      }

      // Playing HUD buttons
      const resetBtn = panel.getElementById('btn-reset');
      if (resetBtn) {
        const onReset = () => this.resetGame();
        resetBtn.addEventListener('click', onReset);
        this.cleanupFuncs.push(() => resetBtn.removeEventListener('click', onReset));
      }

      const diffBtn = panel.getElementById('btn-difficulty');
      if (diffBtn) {
        const onToggleDiff = () => this.toggleDifficulty();
        diffBtn.addEventListener('click', onToggleDiff);
        this.cleanupFuncs.push(() => diffBtn.removeEventListener('click', onToggleDiff));
      }

      // Game Over modal buttons
      const restartBtn = panel.getElementById('btn-gameover-restart');
      if (restartBtn) {
        const onRestart = () => this.restartFromGameOver();
        restartBtn.addEventListener('click', onRestart);
        this.cleanupFuncs.push(() => restartBtn.removeEventListener('click', onRestart));
      }
    }

    this.cleanupFuncs.push(() => this.stockfish.terminate());

    // Setup desktop mouse orbit and click-to-move
    this.setupDesktopMouseControls();
    this.updateDesktopCamera();

    // Show initial Start Screen
    this.showView('start');
  }

  // -------------------------------------------------------------------------
  // View navigation
  // -------------------------------------------------------------------------

  private showView(view: 'start' | 'playing' | 'gameover'): void {
    setViewVisible(this.viewStartEl, view === 'start');
    setViewVisible(this.viewPlayingEl, view === 'playing');
    setViewVisible(this.viewGameOverEl, view === 'gameover');
  }

  private startGame(): void {
    this.gameStarted = true;
    this.gameOver = false;
    this.showView('playing');
    chessAudio.playGameStart();
    this.refreshStatusUI();
  }

  private restartFromGameOver(): void {
    this.resetGame();
    this.startGame();
  }

  // -------------------------------------------------------------------------
  // update — runs every frame, 72–90 fps. NO allocation allowed here.
  // -------------------------------------------------------------------------

  update(delta: number, _time: number): void {
    this.updateSmoothing();
    this.updateHoverGlow();
    this.updateAiAnimation(delta);
    this.updateMouseHover();
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

  /**
   * Hover glow — highlights the piece whose center is closest to either
   * index-tip space and within HOVER_RADIUS. Only White pieces glow for the human.
   */
  private updateHoverGlow(): void {
    if (!this.gameStarted || this.isAiThinking || this.isAiAnimating || this.gameOver) {
      if (this._hoveredEntity) {
        const prevMesh = this._hoveredEntity.object3D;
        if (prevMesh) setHoverGlow(prevMesh, false, 0);
        this._hoveredEntity = null;
      }
      return;
    }

    const heldSet = this.queries.held.entities;

    this.player.indexTipSpaces.left.getWorldPosition(this._tipLeft);
    this.player.indexTipSpaces.right.getWorldPosition(this._tipRight);

    let closest: Entity | null = null;
    let closestDist = HOVER_RADIUS;

    for (const entity of this.queries.pieces.entities) {
      if (heldSet.has(entity)) continue;
      if (entity.getValue(ChessPiece, 'isCaptured')) continue;

      // Only White pieces belong to the human player
      const color = entity.getValue(ChessPiece, 'color');
      if (color !== 'white') continue;

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
      if (this._hoveredEntity) {
        const prevMesh = this._hoveredEntity.object3D;
        if (prevMesh) setHoverGlow(prevMesh, false, 0);
      }
      if (closest) {
        const mesh = closest.object3D;
        if (mesh) setHoverGlow(mesh, true, HOVER_EMISSIVE_WHITE);
      }
      this._hoveredEntity = closest;
    }
  }

  /**
   * Smoothly animates the AI piece along a parabolic 3D arc to its destination square.
   */
  private updateAiAnimation(delta: number): void {
    if (!this.isAiAnimating || !this.aiAnimEntity) return;

    const mesh = this.aiAnimEntity.object3D;
    if (!mesh) {
      this.isAiAnimating = false;
      return;
    }

    this.aiAnimElapsed += delta;
    const t = Math.min(1.0, this.aiAnimElapsed / AI_ANIM_DURATION);

    // Smooth cubic ease in/out
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    // Horizontal interpolation
    mesh.position.x = this._aiStartPos.x + (this._aiEndPos.x - this._aiStartPos.x) * ease;
    mesh.position.z = this._aiStartPos.z + (this._aiEndPos.z - this._aiStartPos.z) * ease;

    // Parabolic arc for vertical lift: raises 0.08m at peak (t = 0.5)
    const arcY = Math.sin(t * Math.PI) * 0.08;
    mesh.position.y = this._aiStartPos.y + (this._aiEndPos.y - this._aiStartPos.y) * ease + arcY;

    // Gentle tilt in direction of travel
    mesh.rotation.x = Math.sin(t * Math.PI) * 0.08;

    if (t >= 1.0) {
      this.isAiAnimating = false;
      mesh.position.copy(this._aiEndPos);
      mesh.rotation.set(0, 0, 0);
      this.finalizeAiMove();
    }
  }

  // -------------------------------------------------------------------------
  // Grab events (Human Player - White)
  // -------------------------------------------------------------------------

  private onGrab(entity: Entity): void {
    if (!this.gameStarted || this.gameOver || this.isAiThinking || this.isAiAnimating) {
      this.grabSystem?.forceRelease(entity);
      return;
    }

    const square = entity.getValue(ChessPiece, 'square') || '';
    const color  = entity.getValue(ChessPiece, 'color')  || 'white';
    if (!square) return;

    // Black pieces are played by Stockfish AI
    if (color === 'black') {
      this.grabSystem?.forceRelease(entity);
      chessAudio.playInvalid();
      if (this.hintEl) {
        this.hintEl.setProperties({ text: 'Black pieces are controlled by Stockfish AI' });
      }
      return;
    }

    // Must be White's turn
    if (turnColor(this.chess) !== 'white') {
      this.grabSystem?.forceRelease(entity);
      chessAudio.playInvalid();
      if (this.hintEl) {
        this.hintEl.setProperties({ text: 'Waiting for Stockfish AI to move...' });
      }
      return;
    }

    chessAudio.playPick();

    // Compute legal destinations from chess.js and highlight squares
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
        moveResult = this.chess.move({ from: fromSq, to: toSq, promotion: 'q' });
      } catch {
        moveResult = null;
      }

      if (moveResult) {
        this.moveCount++;

        // Handle capture
        if (moveResult.captured) {
          const capturedSq = moveResult.flags.includes('e')
            ? toSq[0] + fromSq[1]
            : toSq;
          this.relocateCapturedPiece(capturedSq, 'black');
          chessAudio.playCapture();
        } else {
          chessAudio.playDrop();
        }

        // Handle castling rook
        this.handleCastlingRook(moveResult.flags, 'w');

        // Snap moved piece to target square center, update ECS component.
        this.snapToSquare(entity, toSq);
        entity.setValue(ChessPiece, 'square', toSq);
        entity.setValue(ChessPiece, 'originalSquare', toSq);

        if (moveResult.promotion) {
          entity.setValue(ChessPiece, 'type', 'queen');
        }

        this.checkGameEnd();
        this.currentLegalSquares = [];

        // If game continues, trigger AI (Black) response!
        if (!this.gameOver && turnColor(this.chess) === 'black') {
          this.triggerAiMove();
        } else {
          this.refreshStatusUI();
        }
        return;
      }
    }

    // Illegal drop (off-board, wrong square, or chess.js rejected it).
    chessAudio.playInvalid();
    this.snapToSquare(entity, fromSq);
    this.currentLegalSquares = [];
  }

  // -------------------------------------------------------------------------
  // Stockfish AI (Black)
  // -------------------------------------------------------------------------

  private triggerAiMove(): void {
    this.isAiThinking = true;
    this.refreshStatusUI();

    this.stockfish.getBestMove(this.chess.fen(), (move) => {
      this.onStockfishMove(move);
    });
  }

  private onStockfishMove(move: StockfishMove | null): void {
    if (this.gameOver || turnColor(this.chess) !== 'black') {
      this.isAiThinking = false;
      return;
    }

    this.isAiThinking = false;

    if (!move) {
      this.checkGameEnd();
      this.refreshStatusUI();
      return;
    }

    // Find Black piece entity on move.from
    let aiEntity: Entity | null = null;
    for (const e of this.queries.pieces.entities) {
      if (e.getValue(ChessPiece, 'square') === move.from && !e.getValue(ChessPiece, 'isCaptured')) {
        aiEntity = e;
        break;
      }
    }

    if (!aiEntity || !aiEntity.object3D) {
      // Fallback: apply directly without animation
      this.applyAiMoveDirectly(move);
      return;
    }

    // Setup animation
    this.aiAnimEntity = aiEntity;
    this.aiAnimFromSq = move.from;
    this.aiAnimToSq = move.to;
    this.aiAnimPromotion = move.promotion;
    this.aiAnimElapsed = 0;
    this._aiStartPos.copy(aiEntity.object3D.position);
    this._aiEndPos.copy(squareToWorldPosition(move.to));
    this.isAiAnimating = true;

    chessAudio.playPick();

    if (this.hintEl) {
      this.hintEl.setProperties({
        text: `Stockfish moving ${move.from.toUpperCase()} to ${move.to.toUpperCase()}`,
      });
    }
  }

  private finalizeAiMove(): void {
    if (!this.aiAnimEntity) return;

    let moveResult: ReturnType<Chess['move']> | null = null;
    try {
      moveResult = this.chess.move({
        from: this.aiAnimFromSq,
        to: this.aiAnimToSq,
        promotion: this.aiAnimPromotion || 'q',
      });
    } catch {
      moveResult = null;
    }

    if (moveResult) {
      this.moveCount++;

      if (moveResult.captured) {
        const capturedSq = moveResult.flags.includes('e')
          ? this.aiAnimToSq[0] + this.aiAnimFromSq[1]
          : this.aiAnimToSq;
        this.relocateCapturedPiece(capturedSq, 'white');
        chessAudio.playCapture();
      } else {
        chessAudio.playDrop();
      }

      this.handleCastlingRook(moveResult.flags, 'b');

      this.snapToSquare(this.aiAnimEntity, this.aiAnimToSq);
      this.aiAnimEntity.setValue(ChessPiece, 'square', this.aiAnimToSq);
      this.aiAnimEntity.setValue(ChessPiece, 'originalSquare', this.aiAnimToSq);

      if (moveResult.promotion) {
        this.aiAnimEntity.setValue(ChessPiece, 'type', 'queen');
      }
    } else {
      this.snapToSquare(this.aiAnimEntity, this.aiAnimFromSq);
    }

    this.aiAnimEntity = null;
    this.checkGameEnd();
    this.refreshStatusUI();
  }

  private applyAiMoveDirectly(move: StockfishMove): void {
    try {
      const res = this.chess.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion || 'q',
      });
      if (res) {
        this.moveCount++;
        if (res.captured) {
          const capturedSq = res.flags.includes('e') ? move.to[0] + move.from[1] : move.to;
          this.relocateCapturedPiece(capturedSq, 'white');
          chessAudio.playCapture();
        } else {
          chessAudio.playDrop();
        }
        this.handleCastlingRook(res.flags, 'b');
        for (const e of this.queries.pieces.entities) {
          if (e.getValue(ChessPiece, 'square') === move.from && !e.getValue(ChessPiece, 'isCaptured')) {
            this.snapToSquare(e, move.to);
            e.setValue(ChessPiece, 'square', move.to);
            e.setValue(ChessPiece, 'originalSquare', move.to);
            break;
          }
        }
      }
    } catch (_) {}

    this.checkGameEnd();
    this.refreshStatusUI();
  }

  public toggleDifficulty(): void {
    const current = this.stockfish.getDifficulty();
    const next: Difficulty = current === 'easy' ? 'medium' : 'easy';
    this.stockfish.setDifficulty(next);

    const hudLabel = next === 'easy' ? 'AI: Easy' : 'AI: Medium';
    const startLabel = next === 'easy' ? 'Difficulty: Easy' : 'Difficulty: Medium';

    if (this.diffLabelEl) {
      this.diffLabelEl.setProperties({ text: hudLabel });
    }
    if (this.startDiffLabelEl) {
      this.startDiffLabelEl.setProperties({ text: startLabel });
    }
    chessAudio.playPick();
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

  /** Relocate rook if castling occurred. */
  private handleCastlingRook(flags: string, color: 'w' | 'b'): void {
    let rookFrom = '';
    let rookTo = '';
    if (color === 'w') {
      if (flags.includes('k')) { rookFrom = 'h1'; rookTo = 'f1'; }
      else if (flags.includes('q')) { rookFrom = 'a1'; rookTo = 'd1'; }
    } else {
      if (flags.includes('k')) { rookFrom = 'h8'; rookTo = 'f8'; }
      else if (flags.includes('q')) { rookFrom = 'a8'; rookTo = 'd8'; }
    }

    if (rookFrom && rookTo) {
      for (const entity of this.queries.pieces.entities) {
        if (entity.getValue(ChessPiece, 'square') === rookFrom && !entity.getValue(ChessPiece, 'isCaptured')) {
          this.snapToSquare(entity, rookTo);
          entity.setValue(ChessPiece, 'square', rookTo);
          entity.setValue(ChessPiece, 'originalSquare', rookTo);
          break;
        }
      }
    }
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
  // Visual indicators (Legal Squares & Captures)
  // -------------------------------------------------------------------------

  private showIndicators(moves: Move[]): void {
    this.clearIndicators();
    for (const m of moves) {
      const isCapture = m.captured !== undefined;
      const sq = m.to;
      if (!sq) continue;

      const indicator = createHighlightMarker(isCapture ? 'capture' : 'move');
      const worldPos = squareToWorldPosition(sq);

      // Place slightly above tile to avoid z-fighting
      const yOffset = isCapture ? 0.005 : 0.004;
      indicator.position.set(worldPos.x, worldPos.y + yOffset, worldPos.z);

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

  /** Called after each successful move. Handles end states and floating modal. */
  private checkGameEnd(): void {
    const isCheckmate = this.chess.isCheckmate();
    const isDraw = this.chess.isDraw();

    if (isCheckmate || isDraw) {
      this.gameOver = true;
      const whoseTurn = turnColor(this.chess);
      const diff = this.stockfish.getDifficulty() === 'easy' ? 'Easy' : 'Medium';
      const statsText = `Total Moves: ${this.moveCount} | AI Level: ${diff}`;

      if (isCheckmate) {
        if (whoseTurn === 'black') {
          // Human (White) checkmated Black (AI) -> VICTORY!
          if (this.gameOverTitleEl) this.gameOverTitleEl.setProperties({ text: 'VICTORY!' });
          if (this.gameOverDetailEl) this.gameOverDetailEl.setProperties({ text: 'You checkmated Stockfish AI!' });
          if (this.gameOverStatsEl) this.gameOverStatsEl.setProperties({ text: statsText });
          chessAudio.playWin();
        } else {
          // AI (Black) checkmated White -> DEFEAT
          if (this.gameOverTitleEl) this.gameOverTitleEl.setProperties({ text: 'DEFEAT' });
          if (this.gameOverDetailEl) this.gameOverDetailEl.setProperties({ text: 'Stockfish AI delivered checkmate.' });
          if (this.gameOverStatsEl) this.gameOverStatsEl.setProperties({ text: statsText });
          chessAudio.playDefeat();
        }
      } else {
        // Draw / Stalemate
        let drawReason = 'Match drawn.';
        if (this.chess.isStalemate()) drawReason = 'Stalemate - No legal moves.';
        else if (this.chess.isInsufficientMaterial()) drawReason = 'Draw - Insufficient material.';
        else if (this.chess.isThreefoldRepetition()) drawReason = 'Draw - Threefold repetition.';

        if (this.gameOverTitleEl) this.gameOverTitleEl.setProperties({ text: 'DRAW!' });
        if (this.gameOverDetailEl) this.gameOverDetailEl.setProperties({ text: drawReason });
        if (this.gameOverStatsEl) this.gameOverStatsEl.setProperties({ text: statsText });
        chessAudio.playDrop();
      }

      // Display floating game-over panel
      this.showView('gameover');
      return;
    }

    if (this.chess.inCheck()) {
      chessAudio.playCheck();
    }
  }

  private refreshStatusUI(): void {
    if (!this.statusEl) return;
    const diff = this.stockfish.getDifficulty() === 'easy' ? 'Easy' : 'Medium';

    if (this.isAiThinking) {
      this.statusEl.setProperties({ text: 'AI is thinking...' });
      this.hintEl?.setProperties({ text: `Stockfish (${diff}) calculating reply...` });
    } else if (this.isAiAnimating) {
      this.statusEl.setProperties({ text: 'Stockfish is moving...' });
    } else if (this.chess.inCheck()) {
      const checked = turnColor(this.chess) === 'white' ? 'You are' : 'Stockfish is';
      this.statusEl.setProperties({ text: `${checked} in CHECK!` });
      this.hintEl?.setProperties({ text: 'King is under attack!' });
    } else {
      const whose = turnColor(this.chess);
      if (whose === 'white') {
        this.statusEl.setProperties({ text: 'Your turn (White)' });
        this.hintEl?.setProperties({ text: `Pinch piece to lift | AI: ${diff}` });
      } else {
        this.statusEl.setProperties({ text: 'AI turn (Black)' });
        this.hintEl?.setProperties({ text: `Stockfish (${diff}) preparing move...` });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  public resetGame(): void {
    this.stockfish.stop();
    this.isAiThinking = false;
    this.isAiAnimating = false;
    this.aiAnimEntity = null;

    this.chess.reset();
    this.gameOver = false;
    this.moveCount = 0;
    this.clearIndicators();
    this.currentLegalSquares = [];
    this.capturedWhiteCount = 0;
    this.capturedBlackCount = 0;
    this._hoveredEntity = null;
    this.mouseSelectedEntity = null;

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

  // -------------------------------------------------------------------------
  // Desktop mouse controls — orbit camera + click-to-move
  // These are ignored once WebXR session is active (XR has its own input).
  // -------------------------------------------------------------------------

  /**
   * Register pointer/mouse event listeners on the renderer canvas.
   * - Left drag → orbit the camera around the board.
   * - Left click (no drag) → select/move a White piece.
   */
  private setupDesktopMouseControls(): void {
    const canvas = this.world.renderer.domElement;
    if (!canvas) return;

    const isXrActive = () =>
      this.world.renderer.xr?.isPresenting === true ||
      (this.world as any).session != null;

    const onPointerDown = (e: PointerEvent) => {
      if (isXrActive() || e.button !== 0) return;
      this._pointerDownX = e.clientX;
      this._pointerDownY = e.clientY;
      this._lastPointerX = e.clientX;
      this._lastPointerY = e.clientY;
      this._isOrbiting = false;
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (isXrActive()) return;
      if (!(e.buttons & 1)) return; // left button not held

      const dx = e.clientX - this._lastPointerX;
      const dy = e.clientY - this._lastPointerY;
      this._lastPointerX = e.clientX;
      this._lastPointerY = e.clientY;

      const totalDrag = Math.abs(e.clientX - this._pointerDownX) +
                        Math.abs(e.clientY - this._pointerDownY);
      if (totalDrag > 4) this._isOrbiting = true;

      if (this._isOrbiting) {
        this._cameraTheta -= dx * 0.008;
        this._cameraPhi   -= dy * 0.006;
        // clamp phi: 15° … 85° above board
        this._cameraPhi = Math.max(0.26, Math.min(1.48, this._cameraPhi));
        this.updateDesktopCamera();
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (isXrActive() || e.button !== 0) return;
      canvas.releasePointerCapture(e.pointerId);
      if (!this._isOrbiting) {
        this.handleDesktopClick(e.clientX, e.clientY, canvas);
      }
      this._isOrbiting = false;
    };

    const onWheel = (e: WheelEvent) => {
      if (isXrActive()) return;
      this._cameraRadius = Math.max(0.45, Math.min(1.5, this._cameraRadius + e.deltaY * 0.001));
      this.updateDesktopCamera();
    };

    canvas.addEventListener('pointerdown', onPointerDown as EventListener);
    canvas.addEventListener('pointermove', onPointerMove as EventListener);
    canvas.addEventListener('pointerup',   onPointerUp   as EventListener);
    canvas.addEventListener('wheel',       onWheel       as EventListener, { passive: true });

    this.cleanupFuncs.push(
      () => canvas.removeEventListener('pointerdown', onPointerDown as EventListener),
      () => canvas.removeEventListener('pointermove', onPointerMove as EventListener),
      () => canvas.removeEventListener('pointerup',   onPointerUp   as EventListener),
      () => canvas.removeEventListener('wheel',       onWheel       as EventListener),
    );
  }

  /** Reposition the Three.js camera around the board center using spherical coords. */
  private updateDesktopCamera(): void {
    if ((this.world.renderer.xr as any)?.isPresenting === true) return;
    const cam = this.world.camera;
    const r   = this._cameraRadius;
    cam.position.set(
      this._boardCenter.x + r * Math.sin(this._cameraPhi) * Math.sin(this._cameraTheta),
      this._boardCenter.y + r * Math.cos(this._cameraPhi),
      this._boardCenter.z + r * Math.sin(this._cameraPhi) * Math.cos(this._cameraTheta),
    );
    cam.lookAt(this._boardCenter);
  }

  /**
   * Per-frame mouse hover: highlight the White piece under the cursor.
   * Runs only outside XR.
   */
  private updateMouseHover(): void {
    if ((this.world.renderer.xr as any)?.isPresenting === true) return;
    if (this.mouseSelectedEntity) return; // a piece is already selected
    // hover glow is handled by setHoverGlow below — nothing to do here
    // (actual highlight updates happen in handleDesktopClick path)
  }

  /**
   * Handle a desktop left-click:
   *  - First click on a White piece → select it, show legal moves.
   *  - Second click on a legal square → execute move.
   *  - Click on empty board → deselect.
   */
  private handleDesktopClick(clientX: number, clientY: number, canvas: HTMLElement): void {
    if (!this.gameStarted || this.gameOver || this.isAiThinking || this.isAiAnimating) return;
    if (turnColor(this.chess) !== 'white') return;

    const rect = canvas.getBoundingClientRect();
    this._mouseCoords.set(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      -((clientY - rect.top)  / rect.height) *  2 + 1,
    );

    this._raycaster.setFromCamera(this._mouseCoords, this.world.camera);

    // Collect all piece meshes + board tile meshes
    const meshes: Mesh[] = [];
    const meshToEntity = new Map<Mesh, Entity>();
    for (const entity of this.queries.pieces.entities) {
      if (entity.getValue(ChessPiece, 'isCaptured')) continue;
      const obj = entity.object3D;
      if (!obj) continue;
      obj.traverse((c: Object3D) => {
        if (c instanceof Mesh) {
          meshes.push(c);
          meshToEntity.set(c, entity);
        }
      });
    }

    // --- Board surface as invisible raycast target ---
    const boardPlaneY = this._boardCenter.y + 0.042; // top of tiles
    const ray = this._raycaster.ray;
    // Intersect with board-plane (y = boardPlaneY)
    let boardSq: string | null = null;
    if (Math.abs(ray.direction.y) > 0.0001) {
      const t = (boardPlaneY - ray.origin.y) / ray.direction.y;
      if (t > 0) {
        const hitPt = new Vector3(
          ray.origin.x + ray.direction.x * t,
          boardPlaneY,
          ray.origin.z + ray.direction.z * t,
        );
        boardSq = worldPositionToSquare(hitPt);
      }
    }

    const hits = this._raycaster.intersectObjects(meshes, false);
    const hitEntity = hits.length > 0 ? meshToEntity.get(hits[0].object as Mesh) ?? null : null;

    // — CASE 1: a piece is already selected — try to move —
    if (this.mouseSelectedEntity) {
      const fromSq = this.mouseSelectedEntity.getValue(ChessPiece, 'square') || '';

      // Did the user click a legal target square?
      const targetSq = boardSq;
      if (targetSq && this.currentLegalSquares.includes(targetSq)) {
        // Execute move
        let moveResult: ReturnType<Chess['move']> | null = null;
        try {
          moveResult = this.chess.move({ from: fromSq, to: targetSq, promotion: 'q' });
        } catch { moveResult = null; }

        if (moveResult) {
          this.moveCount++;
          if (moveResult.captured) {
            const capturedSq = moveResult.flags.includes('e')
              ? targetSq[0] + fromSq[1] : targetSq;
            this.relocateCapturedPiece(capturedSq, 'black');
            chessAudio.playCapture();
          } else {
            chessAudio.playDrop();
          }
          this.handleCastlingRook(moveResult.flags, 'w');
          this.snapToSquare(this.mouseSelectedEntity, targetSq);
          this.mouseSelectedEntity.setValue(ChessPiece, 'square', targetSq);
          this.mouseSelectedEntity.setValue(ChessPiece, 'originalSquare', targetSq);
          if (moveResult.promotion) {
            this.mouseSelectedEntity.setValue(ChessPiece, 'type', 'queen');
          }
          this.checkGameEnd();
        } else {
          chessAudio.playInvalid();
        }

        // Clear selection regardless
        const prevMesh = this.mouseSelectedEntity.object3D;
        if (prevMesh) setHoverGlow(prevMesh, false, 0);
        this.mouseSelectedEntity = null;
        this.clearIndicators();
        this.currentLegalSquares = [];

        if (!this.gameOver && turnColor(this.chess) === 'black') {
          this.triggerAiMove();
        } else {
          this.refreshStatusUI();
        }
        return;
      }

      // Clicked a different White piece → switch selection
      if (hitEntity && hitEntity.getValue(ChessPiece, 'color') === 'white') {
        const prevMesh = this.mouseSelectedEntity.object3D;
        if (prevMesh) setHoverGlow(prevMesh, false, 0);
        this.mouseSelectedEntity = null;
        this.clearIndicators();
        this.currentLegalSquares = [];
        // fall through to CASE 2
      } else {
        // Clicked empty / black piece → deselect
        const prevMesh = this.mouseSelectedEntity.object3D;
        if (prevMesh) setHoverGlow(prevMesh, false, 0);
        this.mouseSelectedEntity = null;
        this.clearIndicators();
        this.currentLegalSquares = [];
        this.refreshStatusUI();
        return;
      }
    }

    // — CASE 2: select a White piece —
    if (hitEntity && hitEntity.getValue(ChessPiece, 'color') === 'white') {
      const sq = hitEntity.getValue(ChessPiece, 'square') || '';
      if (!sq) return;
      this.mouseSelectedEntity = hitEntity;
      const mesh = hitEntity.object3D;
      if (mesh) setHoverGlow(mesh, true, HOVER_EMISSIVE_WHITE);

      const moves = this.chess.moves({ square: sq as Square, verbose: true });
      this.currentLegalSquares = moves.map((m) => m.to);
      this.showIndicators(moves);
      chessAudio.playPick();

      if (this.hintEl) {
        const pType = hitEntity.getValue(ChessPiece, 'type') || 'piece';
        this.hintEl.setProperties({ text: `Click destination square for ${pType} on ${sq.toUpperCase()}` });
      }
    }
  }
}
