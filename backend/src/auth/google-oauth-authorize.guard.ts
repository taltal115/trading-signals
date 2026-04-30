import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Extra options merged into Passport's authenticate() before redirect to Google.
 * Without `prompt: 'select_account'`, Google SSO re-links the previously signed-in
 * Google cookie and skips account selection after our app clears its Nest session alone.
 *
 * Applied only on `GET .../google` — the callback stays on the default `@nestjs/passport` flow.
 */
@Injectable()
export class GoogleOauthAuthorizeGuard extends AuthGuard('google') {
  override async getAuthenticateOptions(_context: ExecutionContext) {
    return {
      prompt: 'select_account',
    };
  }
}
