import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { AuthService, SessionUser } from './auth.service';
import { GoogleOAuthConfiguredGuard } from './google-oauth-configured.guard';
import { GoogleOauthAuthorizeGuard } from './google-oauth-authorize.guard';

@Controller('auth')
export class AuthController {
  private readonly log = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService
  ) {}

  @Get('me')
  me(@Req() req: Request): { user: SessionUser | null } {
    return { user: this.authService.sessionUser(req) };
  }

  @Get('google')
  @UseGuards(GoogleOAuthConfiguredGuard, GoogleOauthAuthorizeGuard)
  googleAuth() {
    /* redirects to Google */
  }

  @Get('google/callback')
  @UseGuards(GoogleOAuthConfiguredGuard, AuthGuard('google'))
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const gu = req.user as { email: string; displayName?: string } | undefined;
    if (!gu?.email) {
      return res.redirect(`${this.config.get('frontendUrl')}/login?error=oauth`);
    }
    const fe = this.config.get<string>('frontendUrl') || 'http://localhost:4200';
    try {
      const user = await this.authService.resolveAllowlistedFirebaseUser(
        gu.email,
        gu.displayName ?? null,
      );
      req.session.user = user;
      await new Promise<void>((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
      });
      return res.redirect(`${fe}/dashboard`);
    } catch (e: unknown) {
      if (!(e instanceof UnauthorizedException)) {
        this.log.error(`googleCallback failed after OAuth: ${e instanceof Error ? e.stack || e.message : String(e)}`);
      }
      const msg = e instanceof UnauthorizedException ? e.message : '';
      const code =
        msg.includes('Firebase user not found') ? 'nofirebase' :
        msg.includes('not authorized') ? 'notallowlisted' :
        msg.includes('Firebase Auth admin denied') ? 'authadmin' :
        'forbidden';
      return res.redirect(`${fe}/login?error=${code}`);
    }
  }

  @Get('dev-users')
  devUsers(): { users: Array<{ uid: string; email: string; displayName: string }> } {
    const list = this.config.get('devLocalUsers') as { uid: string; email: string; displayName?: string }[];
    if (
      this.config.get<boolean>('authBypassLocal') !== true ||
      this.config.get<string>('nodeEnv') === 'production' ||
      !Array.isArray(list) ||
      list.length === 0
    ) {
      throw new ForbiddenException();
    }
    return {
      users: list.map((p) => ({
        uid: p.uid,
        email: p.email,
        displayName:
          p.displayName?.trim() ||
          (p.email.includes('@') ? p.email.split('@')[0] : p.email),
      })),
    };
  }

  /** Local only: set httpOnly `dev_persona` cookie for multi-uid testing (requires DEV_LOCAL_USERS). */
  @Post('dev/persona')
  setDevPersona(
    @Res({ passthrough: false }) res: Response,
    @Body() body: { uid?: string },
  ): void {
    const list = this.config.get('devLocalUsers') as {
      uid: string;
      email: string;
      displayName?: string;
    }[];
    if (
      this.config.get<boolean>('authBypassLocal') !== true ||
      this.config.get<string>('nodeEnv') === 'production' ||
      !Array.isArray(list) ||
      list.length === 0
    ) {
      throw new ForbiddenException();
    }
    const wanted = typeof body.uid === 'string' ? body.uid.trim() : '';
    if (!wanted) {
      throw new BadRequestException('uid is required');
    }
    const hit = list.find((p) => p.uid === wanted);
    if (!hit) {
      throw new BadRequestException('Unknown dev persona uid');
    }
    const prod = this.config.get<string>('nodeEnv') === 'production';
    res.cookie('dev_persona', hit.uid, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: prod,
      maxAge: 7 * 24 * 3600 * 1000,
    });
    const displayName =
      hit.displayName?.trim() ||
      (hit.email.includes('@') ? hit.email.split('@')[0] : hit.email);
    res.status(200).json({
      ok: true,
      user: { uid: hit.uid, email: hit.email, displayName },
    });
  }

  @Post('logout')
  logout(@Req() req: Request, @Res() res: Response) {
    req.session.destroy((err) => {
      if (err) {
        res.status(500).json({ ok: false, error: 'session_destroy_failed' });
        return;
      }
      const cookieName = this.config.get<string>('sessionCookieName') || 'signals.sid';
      const prod = this.config.get<string>('nodeEnv') === 'production';
      res.clearCookie(cookieName, {
        path: '/',
        secure: prod,
        sameSite: 'lax',
        httpOnly: true,
      });
      res.clearCookie('dev_persona', {
        path: '/',
        secure: prod,
        sameSite: 'lax',
        httpOnly: true,
      });
      res.json({ ok: true });
    });
  }
}
