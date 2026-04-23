import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthService } from './auth.service';

/** Ensures real Google OAuth env vars are set before Passport's Google strategy runs. */
@Injectable()
export class GoogleOAuthConfiguredGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(_context: ExecutionContext): boolean {
    const hint = this.authService.googleOAuthMissingEnvDescription();
    if (hint) {
      throw new ServiceUnavailableException(`Google OAuth is not configured: ${hint}`);
    }
    return true;
  }
}
