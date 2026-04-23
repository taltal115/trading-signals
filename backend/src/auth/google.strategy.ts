import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.get<string>('googleClientId') || 'missing',
      clientSecret: config.get<string>('googleClientSecret') || 'missing',
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
