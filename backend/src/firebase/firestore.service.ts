import { existsSync, readFileSync } from 'fs';
import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAbsolute, resolve } from 'path';
import * as admin from 'firebase-admin';
import type { DocumentData } from 'firebase-admin/firestore';
import { utcDatetimeLexId } from './my-position-doc-id';
function toPlainFirestoreValue(v: unknown): unknown {
  if (v == null) return v;
  if (v instanceof admin.firestore.Timestamp) {
    return v.toDate().toISOString();
  }
  if (typeof v === 'object' && v !== null && '_seconds' in v && typeof (v as { _seconds: unknown })._seconds === 'number') {
    const ts = v as { _seconds: number; _nanoseconds?: number };
    return new Date(ts._seconds * 1000).toISOString();
  }
  if (Array.isArray(v)) {
    return v.map(toPlainFirestoreValue);
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      out[k] = toPlainFirestoreValue(val);
    }
    return out;
  }
  return v;
}

function toPlainDoc(data: DocumentData | undefined): DocumentData {
  if (!data) return {};
  return toPlainFirestoreValue(data) as DocumentData;
}

type UniverseSymbolSortField =
  | 'ticker'
  | 'score'
  | 'confidence'
  | 'status'
  | 'name'
  | 'sector'
  | 'country'
  | 'market_cap';

const UNIVERSE_SYMBOL_SORT_FIELDS = new Set<string>([
  'ticker',
  'score',
  'confidence',
  'status',
  'name',
  'sector',
  'country',
  'market_cap',
]);

function parseUniverseSymbolSortField(raw?: string): UniverseSymbolSortField {
  const s = String(raw ?? 'score').trim().toLowerCase();
  return UNIVERSE_SYMBOL_SORT_FIELDS.has(s) ? (s as UniverseSymbolSortField) : 'score';
}

function parseUniverseSymbolSortDir(raw?: string): 'asc' | 'desc' {
  return String(raw ?? 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
}

function universeSymbolFirestoreOrderField(
  sort: UniverseSymbolSortField,
): string | admin.firestore.FieldPath {
  switch (sort) {
    case 'score':
      return 'last_score';
    case 'confidence':
      return 'last_confidence';
    case 'ticker':
      return admin.firestore.FieldPath.documentId();
    default:
      return sort;
  }
}

function universeSymbolSortValue(
  row: { ticker: string; detail: DocumentData },
  sort: UniverseSymbolSortField,
): string | number {
  const det = row.detail;
  switch (sort) {
    case 'ticker':
      return row.ticker;
    case 'score': {
      const v = det['last_score'] ?? det['score'];
      const n = Number(v);
      return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
    }
    case 'confidence': {
      const v = det['last_confidence'] ?? det['confidence'];
      const n = Number(v);
      return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
    }
    case 'market_cap': {
      const n = Number(det['market_cap']);
      return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
    }
    case 'status':
      return String(det['status'] ?? '');
    case 'name':
      return String(det['name'] ?? '');
    case 'sector':
      return String(det['sector'] ?? '');
    case 'country':
      return String(det['country'] ?? '');
    default:
      return '';
  }
}

function compareUniverseSymbolRows(
  a: { ticker: string; detail: DocumentData },
  b: { ticker: string; detail: DocumentData },
  sort: UniverseSymbolSortField,
  dir: 'asc' | 'desc',
): number {
  const av = universeSymbolSortValue(a, sort);
  const bv = universeSymbolSortValue(b, sort);
  let cmp: number;
  if (typeof av === 'number' && typeof bv === 'number') {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
  }
  if (cmp === 0) {
    cmp = a.ticker.localeCompare(b.ticker);
  }
  return dir === 'asc' ? cmp : -cmp;
}

function paginateUniverseSymbolRows(
  rows: { ticker: string; detail: DocumentData }[],
  offset: number,
  limit: number,
  sort: UniverseSymbolSortField,
  dir: 'asc' | 'desc',
): { ticker: string; detail: DocumentData }[] {
  const sorted = [...rows].sort((a, b) => compareUniverseSymbolRows(a, b, sort, dir));
  return sorted.slice(offset, offset + limit);
}

/** Open positions (`created_at_utc`; deterministic ids after migrate). */
const MY_POSITIONS_COLLECTION = 'my_positions';

type SignalFlatInst = {
  docId: string;
  asofDate: string;
  docTsUtc: string;
  docTsMs: number;
  signalIndex: number;
  signal: DocumentData;
  tickerU: string;
  sigSortMs: number;
};

function signalParseTimeMs(s: Record<string, unknown>, index: number): number {
  for (const k of ['ts_utc', 'signal_ts', 'updated_at', 'created_at']) {
    const v = s[k];
    if (typeof v === 'string' && v.trim()) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return index;
}

function signalDocTimestampMs(data: DocumentData): number {
  const raw = data['ts_utc'];
  if (typeof raw === 'string' && raw.trim()) {
    const t = Date.parse(raw.trim());
    if (Number.isFinite(t)) return t;
  }
  const ad = String(data['asof_date'] || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(ad)) {
    const t = Date.parse(`${ad}T12:00:00.000Z`);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function flattenSignalDoc(docId: string, data: DocumentData): SignalFlatInst[] {
  const asofDate = String(data['asof_date'] || '');
  const docTsUtc = String(data['ts_utc'] || '');
  const docTsMs = signalDocTimestampMs(data);
  const arr = Array.isArray(data['signals']) ? data['signals'] : [];
  const out: SignalFlatInst[] = [];
  for (let index = 0; index < arr.length; index++) {
    const s = arr[index] as Record<string, unknown>;
    const tickerU = String(s['ticker'] || '')
      .trim()
      .toUpperCase();
    if (!tickerU) continue;
    out.push({
      docId,
      asofDate,
      docTsUtc,
      docTsMs,
      signalIndex: index,
      signal: toPlainDoc(s as DocumentData),
      tickerU,
      sigSortMs: signalParseTimeMs(s, index),
    });
  }
  return out;
}

function compareSignalInstances(a: SignalFlatInst, b: SignalFlatInst): number {
  if (b.docTsMs !== a.docTsMs) return b.docTsMs - a.docTsMs;
  const d = b.sigSortMs - a.sigSortMs;
  if (d !== 0) return d;
  if (b.signalIndex !== a.signalIndex) return b.signalIndex - a.signalIndex;
  return a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0;
}

function encodeSignalInstanceCursor(inst: SignalFlatInst): string {
  return `${inst.docId}\t${inst.signalIndex}`;
}

function parseSignalInstanceCursor(
  cursor: string,
): { docId: string; signalIndex: number } | null {
  const tab = cursor.indexOf('\t');
  if (tab < 0) return null;
  const docId = cursor.slice(0, tab).trim();
  const signalIndex = Number.parseInt(cursor.slice(tab + 1).trim(), 10);
  if (!docId || !Number.isFinite(signalIndex)) return null;
  return { docId, signalIndex };
}

/** True when `inst` is strictly older than `cursorInst` (appears later in newest-first order). */
function signalInstanceAfterCursor(inst: SignalFlatInst, cursorInst: SignalFlatInst): boolean {
  return compareSignalInstances(inst, cursorInst) > 0;
}

/**
 * Resolve relative GOOGLE_APPLICATION_CREDENTIALS by walking up from cwd (e.g. backend/ → repo root).
 * ADC lazy-loads the file on first RPC; if the path stays relative, Node resolves it against cwd and breaks.
 */
function resolveGoogleApplicationCredentialsPath(): void {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!raw || isAbsolute(raw)) return;
  const rel = raw.replace(/^\.\//, '');
  let dir = resolve(process.cwd());
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = candidate;
      return;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
}

@Injectable()
export class FirestoreService implements OnModuleInit {
  private readonly log = new Logger(FirestoreService.name);
  private db!: admin.firestore.Firestore;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    if (admin.apps.length > 0) {
      this.db = admin.firestore();
      return;
    }
    // Inline JSON wins if set — a broken value here overrides the file and yields UNAUTHENTICATED.
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    if (json) {
      const cred = JSON.parse(json) as admin.ServiceAccount;
      admin.initializeApp({ credential: admin.credential.cert(cred) });
      const pid =
        (cred as { project_id?: string }).project_id ?? cred.projectId ?? '?';
      this.log.log(
        `Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON (project_id=${pid})`,
      );
    } else {
      resolveGoogleApplicationCredentialsPath();
      const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
      if (gac && !isAbsolute(gac)) {
        this.log.warn(
          `GOOGLE_APPLICATION_CREDENTIALS "${gac}" not found (searched cwd and parent dirs from ${resolve(process.cwd())}). ` +
            'Firestore will error until the JSON exists or you set an absolute path / FIREBASE_SERVICE_ACCOUNT_JSON.',
        );
      }
      const credPath = gac && isAbsolute(gac) && existsSync(gac) ? gac : null;
      if (credPath) {
        const cred = JSON.parse(readFileSync(credPath, 'utf8')) as admin.ServiceAccount;
        admin.initializeApp({ credential: admin.credential.cert(cred) });
        const pid =
          (cred as { project_id?: string }).project_id ?? cred.projectId ?? '?';
        this.log.log(
          `Firebase Admin initialized from GOOGLE_APPLICATION_CREDENTIALS (project_id=${pid})`,
        );
      } else {
        admin.initializeApp({ credential: admin.credential.applicationDefault() });
        this.log.log('Firebase Admin initialized from application default credentials');
      }
    }
    this.db = admin.firestore();
  }

  get firestore(): admin.firestore.Firestore {
    return this.db;
  }

  auth(): admin.auth.Auth {
    return admin.auth();
  }

  private handleFirestoreListError(
    op: string,
    e: unknown,
    indexMessage?: string,
  ): never {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: number }).code;
    this.log.error(`${op} failed: ${msg}`);
    const lower = msg.toLowerCase();
    if (code === 9 || lower.includes('index')) {
      throw new ServiceUnavailableException(
        indexMessage ||
          `Firestore needs an index for this query (${op}). ` +
            'From repo root run: firebase deploy --only firestore:indexes',
      );
    }
    if (code === 16 || lower.includes('unauthenticated')) {
      throw new InternalServerErrorException(
        'Firestore UNAUTHENTICATED: Google rejected this service account (often invalid_grant / Invalid JWT Signature). ' +
          'Create a new key: Firebase console → Project settings → Service accounts → Generate new private key, replace the JSON file, delete old keys. ' +
          'If FIREBASE_SERVICE_ACCOUNT_JSON is set in .env, remove it or fix it — it overrides GOOGLE_APPLICATION_CREDENTIALS.',
      );
    }
    if (code === 7 || lower.includes('permission')) {
      throw new InternalServerErrorException(
        'Firestore permission denied — check GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_JSON for this project.',
      );
    }
    if (
      lower.includes('enoent') ||
      (lower.includes('does not exist') &&
        (lower.includes('.json') || lower.includes('credential'))) ||
      (lower.includes('lstat') && lower.includes('firebase-adminsdk'))
    ) {
      throw new InternalServerErrorException(
        'Firebase Admin service account file is missing or GOOGLE_APPLICATION_CREDENTIALS points to the wrong path. ' +
          'Use an absolute path, put the JSON in the repo root next to .env, or set FIREBASE_SERVICE_ACCOUNT_JSON.',
      );
    }
    throw new InternalServerErrorException('Firestore query failed');
  }

  /**
   * Paginated universe **snapshot list** (metadata only — no `symbols` / `symbol_details` in the response
   * payload). Use `getUniverseSymbolPage` for symbol rows.
   */
  async listUniversePage(
    pageSize: number,
    cursorDocId?: string,
  ): Promise<{
    docs: {
      id: string;
      data: {
        asof_date?: unknown;
        ts_utc?: unknown;
        source?: unknown;
        symbol_count: number;
        active_count: number;
        inactive_count: number;
        status_counts?: Record<string, number>;
      };
    }[];
    nextCursor: string | null;
  }> {
    try {
      let q: admin.firestore.Query = this.db
        .collection('universe')
        .orderBy('ts_utc', 'desc')
        .limit(pageSize + 1);
      const cur = cursorDocId?.trim();
      if (cur) {
        const curSnap = await this.db.collection('universe').doc(cur).get();
        if (!curSnap.exists) {
          throw new NotFoundException('Invalid pagination cursor');
        }
        q = q.startAfter(curSnap);
      }
      const snap = await q.get();
      const hasMore = snap.docs.length > pageSize;
      const page = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;
      const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;
      return {
        docs: page.map((d) => {
          const raw = toPlainDoc(d.data());
          const syms = raw['symbols'];
          const totalFromField = Number(raw['symbol_count']);
          let activeCount = Number.isFinite(Number(raw['active_count']))
            ? Number(raw['active_count'])
            : Array.isArray(raw['active_symbols'])
              ? (raw['active_symbols'] as unknown[]).length
              : -1;
          let inactiveCount = Number.isFinite(Number(raw['inactive_count']))
            ? Number(raw['inactive_count'])
            : Array.isArray(raw['inactive_symbols'])
              ? (raw['inactive_symbols'] as unknown[]).length
              : -1;
          let total = 0;
          if (Number.isFinite(totalFromField) && totalFromField > 0) {
            total = totalFromField;
          } else if (Array.isArray(syms) && syms.length > 0) {
            total = syms.length;
          } else if (activeCount >= 0 && inactiveCount >= 0) {
            total = activeCount + inactiveCount;
          }
          // Legacy snapshot (no active/inactive split): treat all as active.
          if (activeCount < 0 && inactiveCount < 0) {
            activeCount = total;
            inactiveCount = 0;
          } else {
            if (activeCount < 0) activeCount = Math.max(0, total - Math.max(0, inactiveCount));
            if (inactiveCount < 0) inactiveCount = Math.max(0, total - Math.max(0, activeCount));
          }
          const scRaw = raw['status_counts'];
          let status_counts: Record<string, number> | undefined;
          if (scRaw && typeof scRaw === 'object' && !Array.isArray(scRaw)) {
            status_counts = {};
            for (const [k, v] of Object.entries(scRaw as Record<string, unknown>)) {
              const n = Number(v);
              if (Number.isFinite(n)) status_counts[k] = n;
            }
          }
          return {
            id: d.id,
            data: {
              asof_date: raw['asof_date'],
              ts_utc: raw['ts_utc'],
              source: raw['source'],
              symbol_count: total,
              active_count: activeCount,
              inactive_count: inactiveCount,
              ...(status_counts ? { status_counts } : {}),
            },
          };
        }),
        nextCursor,
      };
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw e;
      }
      this.handleFirestoreListError('listUniversePage', e);
    }
  }

  /** One page of symbols for a universe snapshot (details from inline map or ``symbols`` subcollection). */
  async getUniverseSymbolPage(
    docId: string,
    offset: number,
    limit: number,
    sortRaw?: string,
    dirRaw?: string,
    statusFilter?: string,
  ): Promise<{
    total: number;
    offset: number;
    limit: number;
    sort: string;
    dir: 'asc' | 'desc';
    rows: { ticker: string; detail: DocumentData }[];
  }> {
    try {
      const ref = this.db.collection('universe').doc(docId.trim());
      const snap = await ref.get();
      if (!snap.exists) {
        throw new NotFoundException('Universe snapshot not found');
      }
      const data = toPlainDoc(snap.data());
      const inlineSymbols = Array.isArray(data['symbols'])
        ? (data['symbols'] as unknown[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean)
        : [];
      const activeSymbols = Array.isArray(data['active_symbols'])
        ? (data['active_symbols'] as unknown[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean)
        : [];
      const symbolCountField = Number(data['symbol_count']);
      const activeCountField = Number(data['active_count']);
      const inactiveCountField = Number(data['inactive_count']);
      let total = 0;
      if (Number.isFinite(symbolCountField) && symbolCountField > 0) {
        total = symbolCountField;
      } else if (inlineSymbols.length > 0) {
        total = inlineSymbols.length;
      } else if (
        Number.isFinite(activeCountField) &&
        Number.isFinite(inactiveCountField) &&
        activeCountField >= 0 &&
        inactiveCountField >= 0
      ) {
        total = activeCountField + inactiveCountField;
      } else if (activeSymbols.length > 0) {
        total = activeSymbols.length;
      }
      const inline =
        data['symbol_details'] && typeof data['symbol_details'] === 'object' && !Array.isArray(data['symbol_details'])
          ? (data['symbol_details'] as Record<string, unknown>)
          : {};
      const detailsInSubcollection =
        data['symbol_details_in_subcollection'] === true ||
        (Object.keys(inline).length === 0 && (inlineSymbols.length > 0 || total > 0));

      const sort = parseUniverseSymbolSortField(sortRaw);
      const dir = parseUniverseSymbolSortDir(dirRaw);
      const status = String(statusFilter ?? '')
        .trim()
        .toLowerCase();

      // Scan-list view: page only ``active_symbols`` (usually ≤ top-K).
      if (status === 'active') {
        const tickers = activeSymbols.length > 0 ? activeSymbols : [];
        total = tickers.length;
        if (tickers.length === 0) {
          return { total: 0, offset, limit, sort, dir, rows: [] };
        }
        const pageTickers = tickers.slice(offset, offset + limit);
        let rows: { ticker: string; detail: DocumentData }[];
        if (!detailsInSubcollection && Object.keys(inline).length > 0) {
          rows = pageTickers.map((ticker) => ({
            ticker,
            detail: toPlainDoc(inline[ticker] as DocumentData | undefined) as DocumentData,
          }));
        } else {
          const refs = pageTickers.map((t) => ref.collection('symbols').doc(t));
          const docs = await this.db.getAll(...refs);
          const byId = new Map(
            docs.filter((d) => d.exists).map((d) => [d.id.toUpperCase(), toPlainDoc(d.data()) as DocumentData]),
          );
          rows = pageTickers.map((ticker) => ({
            ticker,
            detail: byId.get(ticker) ?? ({ status: 'active', active: true } as DocumentData),
          }));
        }
        rows = [...rows].sort((a, b) => compareUniverseSymbolRows(a, b, sort, dir));
        return { total, offset, limit, sort, dir, rows };
      }

      let rows: { ticker: string; detail: DocumentData }[];
      if (!detailsInSubcollection && Object.keys(inline).length > 0) {
        rows = paginateUniverseSymbolRows(
          Object.keys(inline).map((ticker) => ({
            ticker: ticker.toUpperCase(),
            detail: toPlainDoc(inline[ticker] as DocumentData | undefined) as DocumentData,
          })),
          offset,
          limit,
          sort,
          dir,
        );
      } else if (detailsInSubcollection || inlineSymbols.length > 0 || activeSymbols.length > 0) {
        const subSnap = await ref
          .collection('symbols')
          .orderBy(universeSymbolFirestoreOrderField(sort), dir)
          .offset(offset)
          .limit(limit)
          .get();
        rows = subSnap.docs.map((d) => ({
          ticker: d.id.toUpperCase(),
          detail: toPlainDoc(d.data()) as DocumentData,
        }));
      } else {
        rows = [];
      }

      if (total === 0 && rows.length > 0) {
        total = rows.length;
      }
      return { total, offset, limit, sort, dir, rows };
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw e;
      }
      this.handleFirestoreListError('getUniverseSymbolPage', e);
    }
  }

  async listSignalsPage(
    pageSize: number,
    cursorDocId?: string,
  ): Promise<{ docs: { id: string; data: DocumentData }[]; nextCursor: string | null }> {
    // Canonical bot run collection only (do not gate on env — a stale FIRESTORE_SIGNALS_COLLECTION
    // silently yields an empty Signals page.)
    const coll = 'signals';
    try {
      let q: admin.firestore.Query = this.db
        .collection(coll)
        .orderBy('ts_utc', 'desc')
        .limit(pageSize + 1);
      const cur = cursorDocId?.trim();
      if (cur) {
        const curSnap = await this.db.collection(coll).doc(cur).get();
        if (!curSnap.exists) {
          throw new NotFoundException('Invalid pagination cursor');
        }
        q = q.startAfter(curSnap);
      }
      const snap = await q.get();
      const hasMore = snap.docs.length > pageSize;
      const page = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;
      const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;
      return {
        docs: page.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) })),
        nextCursor,
      };
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw e;
      }
      this.handleFirestoreListError('listSignalsPage', e);
    }
  }

  async listSignals(limitN: number): Promise<{ id: string; data: DocumentData }[]> {
    const page = await this.listSignalsPage(limitN);
    return page.docs;
  }

  /**
   * Paginate individual BUY rows (`signals[i]`), not run documents.
   * Each bot run stores many tickers in one doc; page size applies to flattened rows.
   */
  async listSignalInstancesPage(
    pageSize: number,
    cursorStr?: string,
  ): Promise<{
    rows: {
      docId: string;
      asofDate: string;
      docTsUtc: string;
      docTsMs: number;
      signalIndex: number;
      signal: DocumentData;
    }[];
    nextCursor: string | null;
    latestRun: { id: string; data: DocumentData } | null;
  }> {
    const coll = 'signals';
    try {
      let cursorInst: SignalFlatInst | null = null;
      const curRaw = cursorStr?.trim();
      if (curRaw) {
        const parsed = parseSignalInstanceCursor(curRaw);
        if (!parsed) {
          throw new NotFoundException('Invalid pagination cursor');
        }
        const curSnap = await this.db.collection(coll).doc(parsed.docId).get();
        if (!curSnap.exists) {
          throw new NotFoundException('Invalid pagination cursor');
        }
        const flat = flattenSignalDoc(parsed.docId, toPlainDoc(curSnap.data()));
        cursorInst =
          flat.find((i) => i.signalIndex === parsed.signalIndex) ?? null;
        if (!cursorInst) {
          throw new NotFoundException('Invalid pagination cursor');
        }
      }

      const latestSnap = await this.db
        .collection(coll)
        .orderBy('ts_utc', 'desc')
        .limit(1)
        .get();
      const latestRun =
        latestSnap.docs.length > 0
          ? { id: latestSnap.docs[0].id, data: toPlainDoc(latestSnap.docs[0].data()) }
          : null;

      const DOC_BATCH = 15;
      const MAX_DOCS = 200;
      let docsScanned = 0;
      let lastDoc: admin.firestore.QueryDocumentSnapshot | null = null;
      const collected: SignalFlatInst[] = [];
      let pageRows: SignalFlatInst[] = [];

      while (docsScanned < MAX_DOCS) {
        let q: admin.firestore.Query = this.db
          .collection(coll)
          .orderBy('ts_utc', 'desc')
          .limit(DOC_BATCH);
        if (lastDoc) {
          q = q.startAfter(lastDoc);
        }
        const snap = await q.get();
        if (snap.empty) break;

        for (const d of snap.docs) {
          collected.push(...flattenSignalDoc(d.id, toPlainDoc(d.data())));
        }
        docsScanned += snap.docs.length;
        lastDoc = snap.docs[snap.docs.length - 1];

        collected.sort(compareSignalInstances);
        let candidates = collected;
        if (cursorInst) {
          candidates = collected.filter((inst) =>
            signalInstanceAfterCursor(inst, cursorInst!),
          );
        }

        if (candidates.length >= pageSize) {
          pageRows = candidates.slice(0, pageSize);
          break;
        }

        if (snap.docs.length < DOC_BATCH) break;
      }

      if (pageRows.length === 0 && collected.length > 0) {
        let candidates = collected;
        if (cursorInst) {
          candidates = collected.filter((inst) =>
            signalInstanceAfterCursor(inst, cursorInst!),
          );
        }
        pageRows = candidates.slice(0, pageSize);
      }

      let nextCursor: string | null = null;
      if (pageRows.length === pageSize) {
        const last = pageRows[pageRows.length - 1];
        let candidates = collected;
        if (cursorInst) {
          candidates = collected.filter((inst) =>
            signalInstanceAfterCursor(inst, cursorInst!),
          );
        }
        const lastIdx = candidates.findIndex(
          (i) =>
            i.docId === last.docId &&
            i.signalIndex === last.signalIndex &&
            i.tickerU === last.tickerU,
        );
        if (lastIdx >= 0 && lastIdx + 1 < candidates.length) {
          nextCursor = encodeSignalInstanceCursor(last);
        }
      }

      return {
        rows: pageRows.map((r) => ({
          docId: r.docId,
          asofDate: r.asofDate,
          docTsUtc: r.docTsUtc,
          docTsMs: r.docTsMs,
          signalIndex: r.signalIndex,
          signal: r.signal,
        })),
        nextCursor,
        latestRun,
      };
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw e;
      }
      this.handleFirestoreListError('listSignalInstancesPage', e);
    }
  }

  async listPositions(ownerUid: string): Promise<{ id: string; data: DocumentData }[]> {
    try {
      const snap = await this.db
        .collection(MY_POSITIONS_COLLECTION)
        .where('owner_uid', '==', ownerUid)
        .orderBy('created_at_utc', 'desc')
        .limit(60)
        .get();
      return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
    } catch (e) {
      this.handleFirestoreListError(
        'listPositions',
        e,
        'Firestore needs the composite index for my_positions (owner_uid + created_at_utc). ' +
          'From repo root run: firebase deploy --only firestore:indexes',
      );
    }
  }

  async addPosition(
    ownerUid: string,
    payload: Record<string, unknown>
  ): Promise<{ id: string }> {
    const raw = payload['created_at_utc'];
    let baseId: string;
    if (typeof raw === 'string' && raw.trim()) {
      const d = new Date(raw.trim());
      baseId = Number.isFinite(d.getTime()) ? utcDatetimeLexId(d) : utcDatetimeLexId(new Date());
    } else {
      baseId = utcDatetimeLexId(new Date());
    }

    for (let dup = 0; dup < 512; dup++) {
      const docId = dup === 0 ? baseId : `${baseId}_dup${dup}`;
      const ref = this.db.collection(MY_POSITIONS_COLLECTION).doc(docId);
      const snap = await ref.get();
      if (snap.exists) continue;
      await ref.set({
        ...payload,
        owner_uid: ownerUid,
      });
      return { id: docId };
    }

    throw new InternalServerErrorException(
      'Could not allocate a unique my_positions document id (try again).'
    );
  }

  async getPosition(
    ownerUid: string,
    docId: string
  ): Promise<{ id: string; data: DocumentData } | null> {
    const ref = this.db.collection(MY_POSITIONS_COLLECTION).doc(docId);
    const doc = await ref.get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (data?.['owner_uid'] !== ownerUid) return null;
    return { id: doc.id, data: toPlainDoc(data!) };
  }

  async updatePosition(
    ownerUid: string,
    docId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    const ref = this.db.collection(MY_POSITIONS_COLLECTION).doc(docId);
    const doc = await ref.get();
    if (!doc.exists) {
      throw new NotFoundException('Position not found');
    }
    const data = doc.data();
    if (data?.['owner_uid'] !== ownerUid) {
      throw new ForbiddenException();
    }
    await ref.update(patch);
  }

  async listPositionChecks(
    ownerUid: string,
    posId: string
  ): Promise<{ id: string; data: DocumentData }[]> {
    try {
      const snap = await this.db
        .collection(MY_POSITIONS_COLLECTION)
        .doc(posId)
        .collection('checks')
        .where('owner_uid', '==', ownerUid)
        .orderBy('ts_utc', 'desc')
        .limit(20)
        .get();
      return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
    } catch (e) {
      this.handleFirestoreListError('listPositionChecks', e);
    }
  }

  async listMonitorChecks(
    ownerUid: string
  ): Promise<{ id: string; data: DocumentData }[]> {
    try {
      const snap = await this.db
        .collectionGroup('checks')
        .where('owner_uid', '==', ownerUid)
        .orderBy('ts_utc', 'desc')
        .limit(100)
        .get();
      return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
    } catch (e) {
      this.handleFirestoreListError('listMonitorChecks', e);
    }
  }

  /**
   * AI eval history for one signal run + ticker (doc id prefix scan).
   */
  async listAiEvalsForSignal(
    signalDocId: string,
    ticker: string,
    limitN = 40,
  ): Promise<{ id: string; data: DocumentData }[]> {
    const sid = signalDocId.trim();
    const sym = ticker.trim().toUpperCase();
    if (!sid || !sym) {
      return [];
    }
    const prefix = `${sid}__${sym}__`;
    try {
      const snap = await this.db
        .collection('ai_evals')
        .orderBy(admin.firestore.FieldPath.documentId())
        .startAt(prefix)
        .endAt(prefix + '\uf8ff')
        .limit(Math.min(Math.max(limitN, 1), 100))
        .get();
      const rows = snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
      rows.sort((a, b) => {
        const ta = String(a.data['ts_utc'] || '');
        const tb = String(b.data['ts_utc'] || '');
        return tb.localeCompare(ta);
      });
      return rows;
    } catch (e) {
      this.handleFirestoreListError('listAiEvalsForSignal', e);
    }
  }

  /** Recent AI evals for analytics (newest first). */
  async listAiEvalsRecent(limitN = 200): Promise<{ id: string; data: DocumentData }[]> {
    try {
      const snap = await this.db
        .collection('ai_evals')
        .orderBy('ts_utc', 'desc')
        .limit(Math.min(Math.max(limitN, 1), 500))
        .get();
      return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
    } catch (e) {
      // Fallback without order if index missing: unscoped get is too heavy; return empty with log
      this.handleFirestoreListError('listAiEvalsRecent', e);
    }
  }
}
