import {
  Controller,
  Get,
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

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService
  ) {}

  @Get('me')
  me(@Req() req: Request): { user: SessionUser | null } {
    return { user: this.authService.sessionUser(req) };
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleAuth() {
    /* redirects to Google */
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const gu = req.user as { email: string } | undefined;
    if (!gu?.email) {
      return res.redirect(`${this.config.get('frontendUrl')}/login?error=oauth`);
    }
    try {
      const user = await this.authService.resolveAllowlistedFirebaseUser(gu.email);
      req.session.user = user;
      await new Promise<void>((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
      });
      return res.redirect(`${this.config.get('frontendUrl')}/dashboard`);
    } catch {
      return res.redirect(`${this.config.get('frontendUrl')}/login?error=forbidden`);
    }
  }

  @Post('logout')
  logout(@Req() req: Request, @Res() res: Response) {
    req.session.destroy((err) => {
      if (err) {
        res.status(500).json({ ok: false, error: 'session_destroy_failed' });
        return;
      }
      res.clearCookie('signals.sid');
      res.json({ ok: true });
    });
  }
}
