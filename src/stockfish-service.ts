/**
 * Stockfish Service for Hand Chess VR.
 * Runs Stockfish 19 inside a browser Web Worker (WASM / ASM-JS fallback)
 * to calculate AI moves asynchronously without blocking the VR render loop.
 */

export type Difficulty = 'easy' | 'medium';

export interface StockfishMove {
  from: string;
  to: string;
  promotion?: string;
}

export class StockfishService {
  private worker: Worker | null = null;
  private isReady = false;
  private isSearching = false;
  private pendingReadyCbs: (() => void)[] = [];
  private moveCallback: ((move: StockfishMove | null) => void) | null = null;
  private difficulty: Difficulty = 'easy';
  private hasFallbackAttempted = false;

  constructor(difficulty: Difficulty = 'easy') {
    this.difficulty = difficulty;
    this.initWorker('/stockfish/stockfish-19-lite-single.js');
  }

  private initWorker(workerScriptUrl: string): void {
    if (typeof window === 'undefined') return;

    try {
      this.worker = new Worker(workerScriptUrl);
    } catch (err) {
      console.warn(`Failed to create worker for ${workerScriptUrl}:`, err);
      if (!this.hasFallbackAttempted && workerScriptUrl !== '/stockfish/stockfish-19-asm.js') {
        this.hasFallbackAttempted = true;
        this.initWorker('/stockfish/stockfish-19-asm.js');
      }
      return;
    }

    this.worker.onmessage = (event: MessageEvent<string>) => {
      this.handleMessage(event.data);
    };

    this.worker.onerror = (err) => {
      console.error('Stockfish worker error:', err);
      if (!this.hasFallbackAttempted && workerScriptUrl !== '/stockfish/stockfish-19-asm.js') {
        this.hasFallbackAttempted = true;
        try {
          this.worker?.terminate();
        } catch (_) {}
        this.initWorker('/stockfish/stockfish-19-asm.js');
      }
    };

    // Initialize UCI protocol
    this.sendCommand('uci');
  }

  private sendCommand(command: string): void {
    if (this.worker) {
      this.worker.postMessage(command);
    }
  }

  private handleMessage(line: string): void {
    if (typeof line !== 'string') return;

    if (line === 'uciok') {
      this.applyDifficulty();
      this.sendCommand('isready');
      return;
    }

    if (line === 'readyok') {
      this.isReady = true;
      while (this.pendingReadyCbs.length > 0) {
        this.pendingReadyCbs.shift()?.();
      }
      return;
    }

    if (line.startsWith('bestmove')) {
      this.isSearching = false;
      const parts = line.split(' ');
      const moveStr = parts[1];

      const cb = this.moveCallback;
      this.moveCallback = null;

      if (!moveStr || moveStr === '(none)') {
        cb?.(null);
        return;
      }

      const from = moveStr.slice(0, 2);
      const to = moveStr.slice(2, 4);
      const promotion = moveStr.length > 4 ? moveStr[4] : undefined;

      cb?.({ from, to, promotion });
    }
  }

  private applyDifficulty(): void {
    // Easy: Skill Level 1 (blunders periodically, relaxed play)
    // Medium: Skill Level 8 (consistent, good positional moves)
    const skillLevel = this.difficulty === 'easy' ? 1 : 8;
    this.sendCommand(`setoption name Skill Level value ${skillLevel}`);
  }

  public setDifficulty(difficulty: Difficulty): void {
    this.difficulty = difficulty;
    if (this.isReady) {
      this.applyDifficulty();
    }
  }

  public getDifficulty(): Difficulty {
    return this.difficulty;
  }

  public stop(): void {
    if (this.isSearching) {
      this.sendCommand('stop');
      this.isSearching = false;
    }
    this.moveCallback = null;
  }

  public getBestMove(fen: string, onMove: (move: StockfishMove | null) => void): void {
    this.moveCallback = onMove;

    const execute = () => {
      this.applyDifficulty();
      this.sendCommand(`position fen ${fen}`);

      // Easy: search depth 2, max 400ms thinking time
      // Medium: search depth 8, max 900ms thinking time
      const depth = this.difficulty === 'easy' ? 2 : 8;
      const movetime = this.difficulty === 'easy' ? 400 : 900;

      this.isSearching = true;
      this.sendCommand(`go depth ${depth} movetime ${movetime}`);
    };

    if (this.isReady) {
      execute();
    } else {
      this.pendingReadyCbs.push(execute);
    }
  }

  public terminate(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this.isReady = false;
  }
}
