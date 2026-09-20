import { Injectable, NotFoundException } from '@nestjs/common';
import { FirestoreService } from '../firebase/firestore.service';
import {
  assemblePipelineGraph,
  type PaperPositionInfo,
  type UniverseSymbolInfo,
} from './pipeline-lifecycle.assembler';
import type { PipelineGraph } from './dto/pipeline-lifecycle.dto';

@Injectable()
export class SignalLifecycleService {
  constructor(private readonly firestore: FirestoreService) {}

  async getLifecycle(params: {
    docId: string;
    ticker: string;
    index?: number;
  }): Promise<PipelineGraph> {
    const docId = String(params.docId || '').trim();
    const ticker = String(params.ticker || '').trim().toUpperCase();
    if (!docId || !ticker) {
      throw new NotFoundException('docId and ticker are required');
    }

    const run = await this.firestore.getSignalRun(docId);
    if (!run) {
      throw new NotFoundException(`Signal run not found: ${docId}`);
    }

    const sigs = run.data['signals'];
    if (!Array.isArray(sigs) || sigs.length === 0) {
      throw new NotFoundException('Run has no signals[]');
    }

    let signalIndex = -1;
    let signal: Record<string, unknown> | null = null;

    if (params.index != null && Number.isFinite(params.index)) {
      const i = Math.floor(Number(params.index));
      const row = sigs[i];
      if (row && typeof row === 'object') {
        const t = String((row as Record<string, unknown>)['ticker'] || '')
          .trim()
          .toUpperCase();
        if (t === ticker) {
          signalIndex = i;
          signal = row as Record<string, unknown>;
        }
      }
    }

    if (!signal) {
      for (let i = 0; i < sigs.length; i++) {
        const row = sigs[i];
        if (!row || typeof row !== 'object') continue;
        const t = String((row as Record<string, unknown>)['ticker'] || '')
          .trim()
          .toUpperCase();
        if (t === ticker) {
          signalIndex = i;
          signal = row as Record<string, unknown>;
          break;
        }
      }
    }

    if (!signal || signalIndex < 0) {
      throw new NotFoundException(
        `Ticker ${ticker} not found in signals run ${docId}`,
      );
    }

    const asofDate = String(run.data['asof_date'] || '').trim();

    const [aiEvals, universeRaw, paper] = await Promise.all([
      this.firestore.listAiEvalsForSignal(docId, ticker, 40),
      asofDate
        ? this.firestore.getUniverseSymbol(asofDate, ticker)
        : Promise.resolve(null),
      this.loadPaper(signal),
    ]);

    let universe: UniverseSymbolInfo | null = null;
    if (universeRaw) {
      universe = {
        active: Boolean(universeRaw['active']),
        status: universeRaw['status'] != null ? String(universeRaw['status']) : undefined,
        inactive_reason:
          universeRaw['inactive_reason'] != null
            ? String(universeRaw['inactive_reason'])
            : undefined,
        active_kind:
          universeRaw['active_kind'] != null
            ? String(universeRaw['active_kind'])
            : undefined,
        last_action:
          universeRaw['last_action'] != null
            ? String(universeRaw['last_action'])
            : undefined,
        last_confidence:
          typeof universeRaw['last_confidence'] === 'number'
            ? universeRaw['last_confidence']
            : Number(universeRaw['last_confidence']) || undefined,
      };
    }

    return assemblePipelineGraph({
      docId,
      ticker,
      signalIndex,
      asofDate,
      signal,
      aiEvals: aiEvals.map((r) => ({
        id: r.id,
        data: r.data as Record<string, unknown>,
      })),
      universe,
      paper,
    });
  }

  private async loadPaper(
    signal: Record<string, unknown>,
  ): Promise<PaperPositionInfo | null> {
    const pid = String(signal['paper_position_id'] || '').trim();
    if (!pid) return null;
    const pos = await this.firestore.getPositionById(pid);
    if (!pos) {
      return {
        id: pid,
        status: String(signal['paper_status'] || '') || undefined,
      };
    }
    const checks = await this.firestore.listPositionChecksById(pid, 8);
    const advice = pos.data['holding_advice'];
    return {
      id: pos.id,
      status: pos.data['status'] != null ? String(pos.data['status']) : undefined,
      holding_advice:
        advice && typeof advice === 'object'
          ? (advice as Record<string, unknown>)
          : undefined,
      holding_advice_at_utc:
        pos.data['holding_advice_at_utc'] != null
          ? String(pos.data['holding_advice_at_utc'])
          : undefined,
      checks: checks.map((c) => ({
        id: c.id,
        data: c.data as Record<string, unknown>,
      })),
    };
  }
}
