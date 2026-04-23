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
    } catch {
      throw new UnauthorizedException('Firebase user not found for this email');
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
