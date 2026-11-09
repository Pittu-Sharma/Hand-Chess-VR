export type PieceType = 'pawn' | 'rook' | 'knight' | 'bishop' | 'queen' | 'king';
export type PieceColor = 'white' | 'black';

export interface ChessPieceData {
  id: string;
  type: PieceType;
  color: PieceColor;
  square: string; // e.g. "e2"
  hasMoved?: boolean;
}

export interface MoveResult {
  valid: boolean;
  capturedPiece?: ChessPieceData;
  isCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  turn: PieceColor;
  san?: string;
}

export class ChessEngine {
  private board: Map<string, ChessPieceData> = new Map();
  public turn: PieceColor = 'white';
  public moveHistory: string[] = [];

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.board.clear();
    this.turn = 'white';
    this.moveHistory = [];

    const setupRow = (row: number, color: PieceColor) => {
      const rank = row === 0 ? '1' : '8';
      const pawnRank = row === 1 ? '2' : '7';
      const order: PieceType[] = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
      const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

      for (let i = 0; i < 8; i++) {
        const sq = `${files[i]}${rank}`;
        this.board.set(sq, {
          id: `${color}_${order[i]}_${i + 1}`,
          type: order[i],
          color,
          square: sq,
          hasMoved: false,
        });
      }

      for (let i = 0; i < 8; i++) {
        const sq = `${files[i]}${pawnRank}`;
        this.board.set(sq, {
          id: `${color}_pawn_${i + 1}`,
          type: 'pawn',
          color,
          square: sq,
          hasMoved: false,
        });
      }
    };

    setupRow(0, 'white');
    setupRow(7, 'black');
  }

  public getPiece(square: string): ChessPieceData | undefined {
    return this.board.get(square.toLowerCase());
  }

  public getAllPieces(): ChessPieceData[] {
    return Array.from(this.board.values());
  }

  public getLegalMoves(square: string): string[] {
    const piece = this.getPiece(square);
    if (!piece || piece.color !== this.turn) return [];

    const rawMoves = this.generatePseudoLegalMoves(piece);
    const legalMoves: string[] = [];

    for (const target of rawMoves) {
      if (this.isMoveSafeForKing(piece.square, target, piece.color)) {
        legalMoves.push(target);
      }
    }

    return legalMoves;
  }

  public makeMove(from: string, to: string): MoveResult {
    from = from.toLowerCase();
    to = to.toLowerCase();

    const piece = this.getPiece(from);
    if (!piece || piece.color !== this.turn) {
      return {
        valid: false,
        isCheck: false,
        isCheckmate: false,
        isStalemate: false,
        turn: this.turn,
      };
    }

    const legalMoves = this.getLegalMoves(from);
    if (!legalMoves.includes(to)) {
      return {
        valid: false,
        isCheck: false,
        isCheckmate: false,
        isStalemate: false,
        turn: this.turn,
      };
    }

    const capturedPiece = this.board.get(to);
    this.board.delete(to);
    this.board.delete(from);

    piece.square = to;
    piece.hasMoved = true;

    // Pawn promotion to Queen
    if (piece.type === 'pawn') {
      const rank = to[1];
      if ((piece.color === 'white' && rank === '8') || (piece.color === 'black' && rank === '1')) {
        piece.type = 'queen';
      }
    }

    this.board.set(to, piece);
    this.moveHistory.push(`${from}-${to}`);

    // Switch turn
    this.turn = this.turn === 'white' ? 'black' : 'white';

    const check = this.isInCheck(this.turn);
    const checkmate = check && this.hasNoLegalMoves(this.turn);
    const stalemate = !check && this.hasNoLegalMoves(this.turn);

    return {
      valid: true,
      capturedPiece,
      isCheck: check,
      isCheckmate: checkmate,
      isStalemate: stalemate,
      turn: this.turn,
      san: `${piece.type.toUpperCase().slice(0, 1)}${to}`,
    };
  }

  private generatePseudoLegalMoves(piece: ChessPieceData): string[] {
    const moves: string[] = [];
    const [fileChar, rankChar] = piece.square;
    const file = fileChar.charCodeAt(0) - 'a'.charCodeAt(0); // 0..7
    const rank = parseInt(rankChar, 10) - 1; // 0..7

    const addMove = (f: number, r: number): boolean => {
      if (f < 0 || f > 7 || r < 0 || r > 7) return false;
      const targetSq = `${String.fromCharCode('a'.charCodeAt(0) + f)}${r + 1}`;
      const occupant = this.board.get(targetSq);

      if (!occupant) {
        moves.push(targetSq);
        return true; // continue sliding
      } else {
        if (occupant.color !== piece.color) {
          moves.push(targetSq); // capture
        }
        return false; // blocked
      }
    };

    if (piece.type === 'pawn') {
      const dir = piece.color === 'white' ? 1 : -1;
      const startRank = piece.color === 'white' ? 1 : 6;

      // 1 step forward
      const fwd1Sq = `${fileChar}${rank + dir + 1}`;
      if (!this.board.has(fwd1Sq) && rank + dir >= 0 && rank + dir <= 7) {
        moves.push(fwd1Sq);
        // 2 steps forward from start
        if (rank === startRank) {
          const fwd2Sq = `${fileChar}${rank + 2 * dir + 1}`;
          if (!this.board.has(fwd2Sq)) {
            moves.push(fwd2Sq);
          }
        }
      }

      // Diagonal captures
      for (const df of [-1, 1]) {
        const targetF = file + df;
        const targetR = rank + dir;
        if (targetF >= 0 && targetF <= 7 && targetR >= 0 && targetR <= 7) {
          const targetSq = `${String.fromCharCode('a'.charCodeAt(0) + targetF)}${targetR + 1}`;
          const targetPiece = this.board.get(targetSq);
          if (targetPiece && targetPiece.color !== piece.color) {
            moves.push(targetSq);
          }
        }
      }
    } else if (piece.type === 'knight') {
      const offsets = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1],
      ];
      for (const [df, dr] of offsets) {
        addMove(file + df, rank + dr);
      }
    } else if (piece.type === 'king') {
      for (let df = -1; df <= 1; df++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (df !== 0 || dr !== 0) {
            addMove(file + df, rank + dr);
          }
        }
      }
    } else {
      // Sliding pieces: rook, bishop, queen
      const directions: [number, number][] = [];
      if (piece.type === 'rook' || piece.type === 'queen') {
        directions.push([0, 1], [0, -1], [1, 0], [-1, 0]);
      }
      if (piece.type === 'bishop' || piece.type === 'queen') {
        directions.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
      }

      for (const [df, dr] of directions) {
        let step = 1;
        while (addMove(file + df * step, rank + dr * step)) {
          step++;
        }
      }
    }

    return moves;
  }

  public isInCheck(color: PieceColor): boolean {
    let kingSquare: string | null = null;
    for (const [sq, piece] of this.board.entries()) {
      if (piece.type === 'king' && piece.color === color) {
        kingSquare = sq;
        break;
      }
    }
    if (!kingSquare) return false;

    const opponentColor = color === 'white' ? 'black' : 'white';
    for (const piece of this.board.values()) {
      if (piece.color === opponentColor) {
        const moves = this.generatePseudoLegalMoves(piece);
        if (moves.includes(kingSquare)) {
          return true;
        }
      }
    }
    return false;
  }

  private isMoveSafeForKing(from: string, to: string, color: PieceColor): boolean {
    const movingPiece = this.board.get(from)!;
    const targetPiece = this.board.get(to);

    this.board.delete(from);
    this.board.set(to, movingPiece);

    const check = this.isInCheck(color);

    this.board.set(from, movingPiece);
    if (targetPiece) {
      this.board.set(to, targetPiece);
    } else {
      this.board.delete(to);
    }

    return !check;
  }

  private hasNoLegalMoves(color: PieceColor): boolean {
    for (const piece of this.board.values()) {
      if (piece.color === color) {
        const legal = this.getLegalMoves(piece.square);
        if (legal.length > 0) return false;
      }
    }
    return true;
  }
}

