import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
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

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap.get('error');
    const msg = messageForOAuthError(q);
    if (msg) this.error.set(msg);
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
