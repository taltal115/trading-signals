import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';

const OAUTH_DISABLED_CLIENT_ID =
  '000000000000-not-configured.apps.googleusercontent.com';
const OAUTH_DISABLED_CLIENT_SECRET = 'not-configured';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    const clientID = config.get<string>('googleClientId')?.trim();
    const clientSecret = config.get<string>('googleClientSecret')?.trim();
    super({
      // passport-oauth2 throws if clientID is falsy — placeholders let the app boot without OAuth.
      clientID: clientID || OAUTH_DISABLED_CLIENT_ID,
      clientSecret: clientSecret || OAUTH_DISABLED_CLIENT_SECRET,
      callbackURL: config.get<string>('googleCallbackUrl'),
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: { emails?: { value: string }[] },
    done: VerifyCallback
  ): void {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      done(new Error('No email from Google'), undefined);
      return;
    }
    done(null, { email: email.trim().toLowerCase() });
  }
}
