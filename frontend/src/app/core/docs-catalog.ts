/**
 * Catalog of Markdown files under repo ``docs/``, served at ``/repo-docs/…``
 * via Angular assets (see ``angular.json``).
 */

export interface AboutDocEntry {
  /** URL-safe id (`/` → `--`). */
  id: string;
  /** Path relative to ``docs/``. */
  path: string;
  title: string;
  category: string;
  summary: string;
}

/** Encode ``docs/``-relative path to a route param. */
export function docPathToId(path: string): string {
  return path.replace(/\//g, '--');
}

/** Decode route param back to ``docs/``-relative path. */
export function docIdToPath(id: string): string {
  return decodeURIComponent(id).replace(/--/g, '/');
}

export const ABOUT_DOCS: AboutDocEntry[] = [
  {
    id: docPathToId('backend-api.md'),
    path: 'backend-api.md',
    title: 'Backend API',
    category: 'Backend & deploy',
    summary: 'Nest routes, auth, env vars, local vs Cloud Run.',
  },
  {
    id: docPathToId('deploy-api-cloud-run.md'),
    path: 'deploy-api-cloud-run.md',
    title: 'Deploy API (Cloud Run)',
    category: 'Backend & deploy',
    summary: 'Hosting rewrite, secrets, market data & workflow env.',
  },
  {
    id: docPathToId('firebase-hosting-setup.md'),
    path: 'firebase-hosting-setup.md',
    title: 'Firebase Hosting setup',
    category: 'Backend & deploy',
    summary: 'SPA build, Firestore rules/indexes, collections overview.',
  },
  {
    id: docPathToId('frontend-angular-architecture.md'),
    path: 'frontend-angular-architecture.md',
    title: 'Angular architecture',
    category: 'Frontend',
    summary: 'SPA layout, Nest HttpClient data path, deploy notes.',
  },
  {
    id: docPathToId('bot-logic-and-strategy.md'),
    path: 'bot-logic-and-strategy.md',
    title: 'Bot logic & strategy',
    category: 'Strategy & ops',
    summary: 'Breakout momentum scoring, BUY/WAIT/SELL, universe load.',
  },
  {
    id: docPathToId('trading-calendar-nys.md'),
    path: 'trading-calendar-nys.md',
    title: 'NYSE trading calendar',
    category: 'Strategy & ops',
    summary: 'Market session calendar used by UI and jobs.',
  },
  {
    id: docPathToId('multi-user-my-positions.md'),
    path: 'multi-user-my-positions.md',
    title: 'Multi-user positions',
    category: 'Strategy & ops',
    summary: 'owner_uid, allowlists, local persona switching.',
  },
  {
    id: docPathToId('ai-signal-pipeline/README.md'),
    path: 'ai-signal-pipeline/README.md',
    title: 'AI signal pipeline (overview)',
    category: 'AI pipeline',
    summary: 'Jobs, stages, and how AI evaluation fits the bot.',
  },
  {
    id: docPathToId('ai-signal-pipeline/ARCHITECTURE.md'),
    path: 'ai-signal-pipeline/ARCHITECTURE.md',
    title: 'AI architecture',
    category: 'AI pipeline',
    summary: 'Pipeline stages, Firestore shapes, gates.',
  },
  {
    id: docPathToId('ai-signal-pipeline/RUNBOOK.md'),
    path: 'ai-signal-pipeline/RUNBOOK.md',
    title: 'AI runbook',
    category: 'AI pipeline',
    summary: 'CLI and GitHub Actions commands (manual triggers).',
  },
  {
    id: docPathToId('ai-signal-pipeline/PROMPTS.md'),
    path: 'ai-signal-pipeline/PROMPTS.md',
    title: 'AI prompts',
    category: 'AI pipeline',
    summary: 'Prompt files and loader notes.',
  },
  {
    id: docPathToId('ai-signal-pipeline/VERDICT_SCHEMA.md'),
    path: 'ai-signal-pipeline/VERDICT_SCHEMA.md',
    title: 'AI verdict schema',
    category: 'AI pipeline',
    summary: 'JSON shape for entry / holding verdicts.',
  },
  {
    id: docPathToId('ai-signal-pipeline/USAGE_AND_ANALYTICS.md'),
    path: 'ai-signal-pipeline/USAGE_AND_ANALYTICS.md',
    title: 'AI usage & analytics',
    category: 'AI pipeline',
    summary: 'ai_evals storage and analytics surfaces.',
  },
  {
    id: docPathToId('research/signal-strategy-research-2026-07.md'),
    path: 'research/signal-strategy-research-2026-07.md',
    title: 'Strategy research (Jul 2026)',
    category: 'Research',
    summary: 'Dated backtest notes; universe section has a current-state supersede note.',
  },
  {
    id: docPathToId('ibkr-client-portal-gateway-plan.md'),
    path: 'ibkr-client-portal-gateway-plan.md',
    title: 'IBKR Client Portal Gateway plan',
    category: 'Plans',
    summary: 'Live holdings via gateway; Phase 1 largely shipped, later phases planned.',
  },
  {
    id: docPathToId('firestore-collection-migration.md'),
    path: 'firestore-collection-migration.md',
    title: 'Firestore signals migration',
    category: 'Migrations',
    summary: 'One-off signals / signals_old collection ops.',
  },
  {
    id: docPathToId('my-positions-collection-migration.md'),
    path: 'my-positions-collection-migration.md',
    title: 'my_positions migration',
    category: 'Migrations',
    summary: 'One-off positions collection promote/copy scripts.',
  },
];

export function findAboutDoc(id: string): AboutDocEntry | undefined {
  const normalized = docIdToPath(id);
  return ABOUT_DOCS.find((d) => d.id === id || d.path === normalized || d.path === id);
}

export function aboutDocsByCategory(): { category: string; docs: AboutDocEntry[] }[] {
  const order: string[] = [];
  const map = new Map<string, AboutDocEntry[]>();
  for (const d of ABOUT_DOCS) {
    if (!map.has(d.category)) {
      map.set(d.category, []);
      order.push(d.category);
    }
    map.get(d.category)!.push(d);
  }
  return order.map((category) => ({ category, docs: map.get(category)! }));
}
