import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { FirestoreService } from '../firebase/firestore.service';
import type { DevLocalUser } from '../types/dev-local-user';

export interface SessionUser {
  uid: string;
  email: string;
  /** Best-effort Gmail / Google profile name for UI and Slack denorm. */
  displayName: string;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly firestore: FirestoreService
  ) {}

  isGoogleOAuthConfigured(): boolean {
    return Boolean(
      this.config.get<string>('googleClientId') && this.config.get<string>('googleClientSecret')
    );
  }

  /** Non-empty if OAuth env is incomplete (for clearer 503s than "not configured"). */
  googleOAuthMissingEnvDescription(): string | null {
    const id = this.config.get<string>('googleClientId')?.trim();
    const secret = this.config.get<string>('googleClientSecret')?.trim();
    const missing: string[] = [];
    if (!id) missing.push('GOOGLE_CLIENT_ID');
    if (!secret) missing.push('GOOGLE_CLIENT_SECRET');
    if (missing.length === 0) return null;
    return `Set ${missing.join(' and ')} on this process (e.g. Cloud Run → Variables & secrets). Callback URL changes do not replace these.`;
  }

  /**
   * Local dev persona when AUTH_BYPASS_LOCAL is set — overridden by cookie + DEV_LOCAL_USERS
   * via `getBypassUserForRequest` in a later step.
   */
  getBypassUser(): SessionUser | null {
    const bypass =
      this.config.get<boolean>('authBypassLocal') === true &&
      this.config.get<string>('nodeEnv') !== 'production';
    if (!bypass) return null;
    const uid = this.config.get<string>('devOwnerUid');
    if (!uid) {
      this.log.warn('AUTH_BYPASS_LOCAL is true but DEV_OWNER_UID is empty');
      return null;
    }
    const email = this.config.get<string>('devUserEmail') || 'dev@localhost';
    return {
      uid,
      email,
      displayName:
        this.config.get<string>('devUserDisplayName')?.trim() ||
        SessionUserFns.emailLocalPart(email),
    };
  }

  sessionUser(req: Request): SessionUser | null {
    const bypass = this.getBypassUserForRequest(req);
    if (bypass) return bypass;
    const raw = req.session?.user;
    if (!raw?.uid || !raw.email) return null;
    const email = String(raw.email).trim().toLowerCase();
    const fromSession =
      typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    return {
      uid: raw.uid,
      email,
      displayName:
        fromSession || SessionUserFns.emailLocalPart(email),
    };
  }

  requireUser(req: Request): SessionUser {
    const u = this.sessionUser(req);
    if (!u) throw new UnauthorizedException('Sign in required');
    return u;
  }

  /**
   * When bypass is on and `DEV_LOCAL_USERS` is configured, selects persona from `dev_persona` cookie.
   * Else falls back to `getBypassUser()` (legacy DEV_OWNER_UID).
   */
  getBypassUserForRequest(req: Request): SessionUser | null {
    const bypassEnv =
      this.config.get<boolean>('authBypassLocal') === true &&
      this.config.get<string>('nodeEnv') !== 'production';
    if (!bypassEnv) return null;

    const list = this.config.get<DevLocalUser[]>('devLocalUsers') || [];
    if (list.length === 0) return this.getBypassUser();

    const cookieUid =
      typeof req.cookies?.['dev_persona'] === 'string'
        ? req.cookies!['dev_persona'].trim()
        : '';
    const pick =
      (cookieUid && list.find((p) => p.uid === cookieUid)) || list[0];
    return {
      uid: pick.uid,
      email: pick.email,
      displayName:
        pick.displayName?.trim() || SessionUserFns.emailLocalPart(pick.email),
    };
  }

  async resolveAllowlistedFirebaseUser(
    emailRaw: string,
    oauthDisplayName?: string | null,
  ): Promise<SessionUser> {
    const email = String(emailRaw || '')
      .trim()
      .toLowerCase();
    if (!email) throw new UnauthorizedException('No email from Google');

    const allowedEmails = this.config.get<string[]>('allowedEmails') || [];
    const allowedUids = this.config.get<string[]>('allowedUids') || [];

    let userRecord;
    try {
      userRecord = await this.firestore.auth().getUserByEmail(email);
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`getUserByEmail(${email}) failed: ${code || 'no-code'} ${msg}`);
      if (code === 'auth/user-not-found') {
        throw new UnauthorizedException('Firebase user not found for this email');
      }
      throw new UnauthorizedException(
        'Firebase Auth admin denied — grant the Cloud Run runtime service account role roles/firebaseauth.admin on this GCP project (or fix FIREBASE_SERVICE_ACCOUNT_JSON / ADC project).',
      );
    }

    const ue = String(userRecord.email || email).trim().toLowerCase();

    if (allowedUids.length > 0 && allowedUids.includes(userRecord.uid)) {
      return {
        uid: userRecord.uid,
        email: ue,
        displayName: SessionUserFns.resolveDisplayName(
          ue,
          userRecord.displayName,
          oauthDisplayName,
        ),
      };
    }
    if (allowedEmails.length > 0) {
      if (!allowedEmails.includes(ue)) {
        throw new UnauthorizedException('This account is not authorized');
      }
    }

    return {
      uid: userRecord.uid,
      email: ue,
      displayName: SessionUserFns.resolveDisplayName(
        ue,
        userRecord.displayName,
        oauthDisplayName,
      ),
    };
  }
}

/** Parsing / display helpers — avoids static method issues under Nest injection. */
const SessionUserFns = {
  emailLocalPart(email: string): string {
    const at = email.indexOf('@');
    return at > 0 ? email.slice(0, at) : email;
  },

  resolveDisplayName(
    email: string,
    firebaseDisplay?: string | null,
    oauthDisplay?: string | null,
  ): string {
    const o = oauthDisplay?.trim();
    if (o) return o;
    const f = firebaseDisplay?.trim();
    if (f) return f;
    return SessionUserFns.emailLocalPart(email);
  },
};

/** Re-export for controllers that need the dev-persona list shape. */
export type { DevLocalUser } from '../types/dev-local-user';
