import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.css',
})
export class LoginPageComponent {
  readonly authSvc = inject(AuthService);
  readonly loading = signal(false);
  readonly error = signal('');

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
