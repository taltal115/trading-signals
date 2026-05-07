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

/** Open positions (`created_at_utc`; deterministic ids after migrate). */
const MY_POSITIONS_COLLECTION = 'my_positions';

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
          const total = Array.isArray(syms) ? syms.length : 0;
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
          // Legacy snapshot (no active/inactive split): treat all as active.
          if (activeCount < 0 && inactiveCount < 0) {
            activeCount = total;
            inactiveCount = 0;
          } else {
            if (activeCount < 0) activeCount = Math.max(0, total - Math.max(0, inactiveCount));
            if (inactiveCount < 0) inactiveCount = Math.max(0, total - Math.max(0, activeCount));
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

  /** One page of symbols for a universe snapshot document (full doc read; sliced in memory). */
  async getUniverseSymbolPage(
    docId: string,
    offset: number,
    limit: number,
  ): Promise<{
    total: number;
    offset: number;
    limit: number;
    rows: { ticker: string; detail: DocumentData }[];
  }> {
    try {
      const ref = this.db.collection('universe').doc(docId.trim());
      const snap = await ref.get();
      if (!snap.exists) {
        throw new NotFoundException('Universe snapshot not found');
      }
      const data = toPlainDoc(snap.data());
      const symbols = Array.isArray(data['symbols'])
        ? (data['symbols'] as unknown[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean)
        : [];
      const details =
        data['symbol_details'] && typeof data['symbol_details'] === 'object' && !Array.isArray(data['symbol_details'])
          ? (data['symbol_details'] as Record<string, unknown>)
          : {};
      const slice = symbols.slice(offset, offset + limit);
      const rows = slice.map((ticker) => ({
        ticker,
        detail: toPlainDoc(details[ticker] as DocumentData | undefined) as DocumentData,
      }));
      return { total: symbols.length, offset, limit, rows };
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw e;
      }
      this.handleFirestoreListError('getUniverseSymbolPage', e);
    }
  }

  async listSignals(limitN: number): Promise<{ id: string; data: DocumentData }[]> {
    // Canonical bot run collection only (do not gate on env — a stale FIRESTORE_SIGNALS_COLLECTION
    // silently yields an empty Signals page.)
    const coll = 'signals';
    try {
      const snap = await this.db
        .collection(coll)
        .orderBy('ts_utc', 'desc')
        .limit(limitN)
        .get();
      return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
    } catch (e) {
      this.handleFirestoreListError('listSignals', e);
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

  /** Most recent open row matching ticker and linked signal doc (in-memory filter on listPositions). */
  async findOpenPositionForSignal(
    ownerUid: string,
    ticker: string,
    signalDocId: string,
  ): Promise<{ id: string } | null> {
    const rows = await this.listPositions(ownerUid);
    const sym = ticker.trim().toUpperCase();
    const sig = signalDocId.trim();
    for (const r of rows) {
      const st = String(r.data['status'] ?? 'open');
      if (st !== 'open') continue;
      if (String(r.data['ticker'] ?? '').trim().toUpperCase() !== sym) continue;
      if (String(r.data['signal_doc_id'] ?? '').trim() !== sig) continue;
      return { id: r.id };
    }
    return null;
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
}
