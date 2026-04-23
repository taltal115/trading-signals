import * as admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import session from 'express-session';
import { FirestoreService } from '../firebase/firestore.service';

type Sess = session.SessionData;

function serializeSession(sess: Sess): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(sess, (_k, v) => (v instanceof Date ? { __isoDate: v.toISOString() } : v)),
  ) as Record<string, unknown>;
}

function deserializeSession(data: unknown): Sess {
  return JSON.parse(JSON.stringify(data), (_k, v) => {
    if (v && typeof v === 'object' && '__isoDate' in v && typeof (v as { __isoDate: unknown }).__isoDate === 'string') {
      return new Date((v as { __isoDate: string }).__isoDate);
    }
    return v;
  }) as Sess;
}

/**
 * express-session store backed by Firestore so Cloud Run (multi-instance / cold start) shares sessions.
 * Default MemoryStore only works for a single in-memory process.
 */
export class FirestoreSessionStore extends session.Store {
  private readonly collectionName: string;

  /**
   * Hold FirestoreService (not a Firestore snapshot): at Nest bootstrap, `app.get(FirestoreService).firestore`
   * can still be undefined before `onModuleInit` completes; lazy access avoids `this.db.collection` 500s.
   */
  constructor(
    private readonly firestoreService: FirestoreService,
    private readonly ttlMs: number,
    collectionName = '_nest_sessions',
  ) {
    super();
    this.collectionName = collectionName;
  }

  private db(): Firestore {
    return this.firestoreService.firestore;
  }

  override get(
    sid: string,
    callback: (err: unknown, session?: Sess | null) => void,
  ): void {
    void this.db()
      .collection(this.collectionName)
      .doc(sid)
      .get()
      .then((doc) => {
        if (!doc.exists) {
          callback(null, null);
          return;
        }
        const data = doc.data();
        const exp = data?.['expiresAt'] as admin.firestore.Timestamp | undefined;
        if (exp && exp.toMillis() < Date.now()) {
          void this.destroy(sid, () => callback(null, null));
          return;
        }
        const raw = data?.['session'];
        if (raw == null) {
          callback(null, null);
          return;
        }
        try {
          callback(null, deserializeSession(raw));
        } catch (e) {
          callback(e);
        }
      })
      .catch((err) => callback(err));
  }

  override set(sid: string, sess: Sess, callback?: (err?: unknown) => void): void {
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + this.ttlMs);
    void this.db()
      .collection(this.collectionName)
      .doc(sid)
      .set({
        session: serializeSession(sess),
        expiresAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  override destroy(sid: string, callback?: (err?: unknown) => void): void {
    void this.db()
      .collection(this.collectionName)
      .doc(sid)
      .delete()
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  override touch(sid: string, _sess: Sess, callback?: (err?: unknown) => void): void {
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + this.ttlMs);
    void this.db()
      .collection(this.collectionName)
      .doc(sid)
      .update({ expiresAt })
      .then(() => callback?.())
      .catch((err) => {
        const code = (err as { code?: number }).code;
        if (code === 5) {
          callback?.();
          return;
        }
        callback?.(err);
      });
  }
}
