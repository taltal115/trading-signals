import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import { AuthService } from '../../core/auth.service';

function messageForOAuthError(code: string | null): string {
  switch (code) {
    case 'oauth':
      return 'Google sign-in did not return an email. Try again or use a different Google account.';
    case 'nofirebase':
      return (
        'This Google account is not registered in Firebase Authentication for this project. ' +
        'In Firebase Console → Authentication → Users, add a user with this email (or enable Google provider and sign in once there).'
      );
    case 'notallowlisted':
      return (
        'This account is not allowlisted on the server. Set ALLOWED_SIGN_IN_EMAILS and/or ALLOWED_AUTH_UIDS on Cloud Run to include your email or Firebase UID.'
      );
    case 'authadmin':
      return (
        'The API cannot read Firebase Authentication (IAM). In Google Cloud → IAM, grant the Cloud Run runtime service account the role Firebase Authentication Admin (roles/firebaseauth.admin) on this GCP project, then try again.'
      );
    case 'forbidden':
      return 'Sign-in was denied. If this persists, check API logs after OAuth callback.';
    default:
      return '';
  }
}

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.css',
})
export class LoginPageComponent implements OnInit {
  readonly authSvc = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  readonly loading = signal(false);
  readonly error = signal('');

  async ngOnInit(): Promise<void> {
    const q = this.route.snapshot.queryParamMap.get('error');
    const oauthMsg = messageForOAuthError(q);
    if (oauthMsg) {
      this.error.set(oauthMsg);
      return;
    }
    if (!this.authSvc.devAuthBypass) {
      /** After `/me`; detect deployed SPA allowlist lagging Nest (looks like MIME / chunk failures). */
      await this.authSvc.refreshMe();
      const u = await firstValueFrom(this.authSvc.user$.pipe(take(1)));
      const email =
        typeof u?.email === 'string' ? u!.email!.trim().toLowerCase() : '';
      if (u && email && !this.authSvc.isAllowed(u)) {
        this.error.set(
          'Google sign-in succeeded, but this site build\'s email allowlist does not include your account yet. ' +
            'Ask the deployer to add your Gmail to frontend/src/environments/environment.prod.ts, redeploy Hosting, then hard‑refresh…'
        );
      }
    }
  }

  googleSignIn(): void {
    this.error.set('');
    this.loading.set(true);
    try {
      this.authSvc.startGoogleLogin();
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
      this.loading.set(false);
    }
  }
}
