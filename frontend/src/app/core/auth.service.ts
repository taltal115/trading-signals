import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import {
  BehaviorSubject,
  Observable,
  distinctUntilChanged,
  map,
  shareReplay,
} from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthUser, isUserAllowed, primaryAccountEmail } from './auth-allowlist';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  readonly devAuthBypass = environment.devAuthBypass;

  private readonly userSubject = new BehaviorSubject<AuthUser | null>(null);
  readonly user$: Observable<AuthUser | null> = this.userSubject.asObservable();

  readonly allowedUser$: Observable<AuthUser | null> = this.user$.pipe(
    map((u) => {
      if (!u) return null;
      if (environment.devAuthBypass) return u;
      return isUserAllowed(u, environment.allowedSignInEmails, environment.allowedAuthUids)
        ? u
        : null;
    }),
    distinctUntilChanged((a, b) => a?.uid === b?.uid),
    shareReplay(1)
  );

  constructor() {
    void this.refreshMe();
  }

  async refreshMe(): Promise<void> {
    try {
      const r = await firstValueFrom(
        this.http.get<{ user: AuthUser | null }>(`${environment.apiBaseUrl}/api/auth/me`)
      );
      this.userSubject.next(r.user);
    } catch {
      this.userSubject.next(null);
    }
  }

  isAllowed(user: AuthUser | null): boolean {
    if (!user) return false;
    if (environment.devAuthBypass) return true;
    return isUserAllowed(user, environment.allowedSignInEmails, environment.allowedAuthUids);
  }

  /** Redirect browser to Nest Google OAuth (or 503 if not configured — only used when not bypass). */
  startGoogleLogin(): void {
    const base = environment.apiBaseUrl || '';
    window.location.href = `${base}/api/auth/google`;
  }

  async signOutApp(): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post<{ ok: boolean }>(`${environment.apiBaseUrl}/api/auth/logout`, {})
      );
    } catch {
      /* ignore */
    }
    this.userSubject.next(null);
    if (environment.devAuthBypass) {
      await this.router.navigate(['/dashboard'], { replaceUrl: true });
    } else {
      await this.router.navigate(['/login'], { replaceUrl: true });
    }
  }

  displayEmail(user: AuthUser | null): string {
    if (!user) return '';
    return user.email || primaryAccountEmail(user) || user.uid;
  }
}
