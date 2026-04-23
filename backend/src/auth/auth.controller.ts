import {
  Controller,
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
  @UseGuards(GoogleOAuthConfiguredGuard, AuthGuard('google'))
  googleAuth() {
    /* redirects to Google */
  }

  @Get('google/callback')
  @UseGuards(GoogleOAuthConfiguredGuard, AuthGuard('google'))
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const gu = req.user as { email: string } | undefined;
    if (!gu?.email) {
      return res.redirect(`${this.config.get('frontendUrl')}/login?error=oauth`);
    }
    const fe = this.config.get<string>('frontendUrl') || 'http://localhost:4200';
    try {
      const user = await this.authService.resolveAllowlistedFirebaseUser(gu.email);
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
      res.json({ ok: true });
    });
  }
}
