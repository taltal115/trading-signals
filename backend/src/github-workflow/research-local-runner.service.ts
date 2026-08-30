import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

export type LocalResearchParams = {
  runId: string;
  since: string;
  until?: string;
  actionableOnly: boolean;
  includeImmature: boolean;
  limitRuns: number;
  notifySlack: boolean;
  actor?: string | null;
};

/**
 * Runs profit-hold research via local Python (dev / GHA-unavailable fallback).
 * Does not block the HTTP response — script updates Firestore `research_runs`.
 */
@Injectable()
export class ResearchLocalRunnerService {
  private readonly log = new Logger(ResearchLocalRunnerService.name);

  constructor(private readonly config: ConfigService) {}

  /** Prefer local runner when explicitly enabled or local auth bypass (typical `npm run start:dev`). */
  preferLocal(): boolean {
    if (process.env.RESEARCH_RUN_LOCAL === 'true') return true;
    if (process.env.RESEARCH_RUN_LOCAL === 'false') return false;
    return this.config.get<boolean>('authBypassLocal') === true;
  }

  start(params: LocalResearchParams): void {
    const repoRoot = this.resolveRepoRoot();
    const script = join(repoRoot, 'scripts', 'run_ui_profit_hold_research.py');
    if (!existsSync(script)) {
      throw new ServiceUnavailableException(
        `Research script not found at ${script}. Run from the trading-signals repo.`,
      );
    }
    const python = this.resolvePython(repoRoot);
    const args = [
      script,
      '--config',
      'config.yaml',
      '--since',
      params.since,
      '--limit-runs',
      String(params.limitRuns),
      '--run-id',
      params.runId,
      '--trigger-source',
      'ui',
    ];
    if (params.until) {
      args.push('--until', params.until);
    }
    if (params.actionableOnly) args.push('--actionable-only');
    if (params.includeImmature) args.push('--include-immature');
    if (params.notifySlack) args.push('--notify-slack');
    if (params.actor) args.push('--trigger-actor', params.actor);

    this.log.log(
      `Starting local research run_id=${params.runId} python=${python} cwd=${repoRoot}`,
    );
    const child = spawn(python, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONPATH: `./src:.${process.env.PYTHONPATH ? `:${process.env.PYTHONPATH}` : ''}`,
      },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', (err) => {
      this.log.error(`Local research spawn failed run_id=${params.runId}: ${err.message}`);
    });
  }

  private resolveRepoRoot(): string {
    const override = (process.env.RESEARCH_REPO_ROOT || '').trim();
    if (override && existsSync(join(override, 'scripts', 'run_ui_profit_hold_research.py'))) {
      return resolve(override);
    }
    // Nest is usually started from `backend/`; repo root is parent.
    const fromBackend = resolve(process.cwd(), '..');
    if (existsSync(join(fromBackend, 'scripts', 'run_ui_profit_hold_research.py'))) {
      return fromBackend;
    }
    if (existsSync(join(process.cwd(), 'scripts', 'run_ui_profit_hold_research.py'))) {
      return resolve(process.cwd());
    }
    return fromBackend;
  }

  private resolvePython(repoRoot: string): string {
    const envPy = (process.env.RESEARCH_PYTHON || '').trim();
    if (envPy) return envPy;
    const venvPy = join(repoRoot, '.venv', 'bin', 'python');
    if (existsSync(venvPy)) return venvPy;
    return 'python3';
  }
}
