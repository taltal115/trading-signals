import { existsSync } from 'fs';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { isAbsolute, join, resolve } from 'path';
import * as admin from 'firebase-admin';
import type { DocumentData } from 'firebase-admin/firestore';

/** JSON-serialize Firestore types (Timestamp, nested) for HTTP responses. */
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

/** Resolve relative GOOGLE_APPLICATION_CREDENTIALS from cwd and repo root (parent of backend/). */
function resolveGoogleApplicationCredentialsPath(): void {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!raw || isAbsolute(raw)) return;
  const cwd = process.cwd();
  const candidates = [join(cwd, raw), join(cwd, '..', raw)];
  for (const c of candidates) {
    if (existsSync(c)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(c);
      return;
    }
  }
}

@Injectable()
export class FirestoreService implements OnModuleInit {
  private readonly log = new Logger(FirestoreService.name);
  private db!: admin.firestore.Firestore;

  onModuleInit() {
    if (admin.apps.length > 0) {
      this.db = admin.firestore();
      return;
    }
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    if (json) {
      const cred = JSON.parse(json) as admin.ServiceAccount;
      admin.initializeApp({ credential: admin.credential.cert(cred) });
      this.log.log('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON');
    } else {
      resolveGoogleApplicationCredentialsPath();
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
      this.log.log('Firebase Admin initialized from application default credentials');
    }
    this.db = admin.firestore();
  }

  get firestore(): admin.firestore.Firestore {
    return this.db;
  }

  auth(): admin.auth.Auth {
    return admin.auth();
  }

  async listUniverse(limitN: number): Promise<{ id: string; data: DocumentData }[]> {
    const snap = await this.db
      .collection('universe')
      .orderBy('ts_utc', 'desc')
      .limit(limitN)
      .get();
    return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
  }

  async listSignals(limitN: number): Promise<{ id: string; data: DocumentData }[]> {
    const snap = await this.db
      .collection('signals')
      .orderBy('ts_utc', 'desc')
      .limit(limitN)
      .get();
    return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
  }

  async listPositions(ownerUid: string): Promise<{ id: string; data: DocumentData }[]> {
    const snap = await this.db
      .collection('my_positions')
      .where('owner_uid', '==', ownerUid)
      .orderBy('created_at_utc', 'desc')
      .limit(60)
      .get();
    return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
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
    const docRef = await this.db.collection('my_positions').add({
      ...payload,
      owner_uid: ownerUid,
    });
    return { id: docRef.id };
  }

  async getPosition(
    ownerUid: string,
    docId: string
  ): Promise<{ id: string; data: DocumentData } | null> {
    const ref = this.db.collection('my_positions').doc(docId);
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
    const ref = this.db.collection('my_positions').doc(docId);
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
    const snap = await this.db
      .collection('my_positions')
      .doc(posId)
      .collection('checks')
      .where('owner_uid', '==', ownerUid)
      .orderBy('ts_utc', 'desc')
      .limit(20)
      .get();
    return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
  }

  async listMonitorChecks(
    ownerUid: string
  ): Promise<{ id: string; data: DocumentData }[]> {
    const snap = await this.db
      .collectionGroup('checks')
      .where('owner_uid', '==', ownerUid)
      .orderBy('ts_utc', 'desc')
      .limit(100)
      .get();
    return snap.docs.map((d) => ({ id: d.id, data: toPlainDoc(d.data()) }));
  }
}
