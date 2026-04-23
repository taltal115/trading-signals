import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirestoreService } from '../firebase/firestore.service';

export interface SessionUser {
  uid: string;
  email: string;
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
    return {
      uid,
      email: this.config.get<string>('devUserEmail') || 'dev@localhost',
    };
  }

  sessionUser(req: { session?: { user?: SessionUser } }): SessionUser | null {
    const bypass = this.getBypassUser();
    if (bypass) return bypass;
    return req.session?.user ?? null;
  }

  requireUser(req: { session?: { user?: SessionUser } }): SessionUser {
    const u = this.sessionUser(req);
    if (!u) throw new UnauthorizedException('Sign in required');
    return u;
  }

  async resolveAllowlistedFirebaseUser(emailRaw: string): Promise<SessionUser> {
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

    if (allowedUids.length > 0 && allowedUids.includes(userRecord.uid)) {
      return { uid: userRecord.uid, email: userRecord.email || email };
    }
    if (allowedEmails.length > 0) {
      const ue = String(userRecord.email || email)
        .trim()
        .toLowerCase();
      if (!allowedEmails.includes(ue)) {
        throw new UnauthorizedException('This account is not authorized');
      }
    }

    return { uid: userRecord.uid, email: userRecord.email || email };
  }
}
