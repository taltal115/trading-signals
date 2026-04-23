import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import { AuthService } from './auth.service';

/** Require session + allowlist (production). Always refresh `/api/auth/me` first so DEV_OWNER_UID populates before child routes load. */
export const shellGuard: CanActivateFn = async () => {
  const authSvc = inject(AuthService);
  const router = inject(Router);
  await authSvc.refreshMe();
  if (authSvc.devAuthBypass) return true;
  const u = await firstValueFrom(authSvc.user$.pipe(take(1)));
  if (u && authSvc.isAllowed(u)) return true;
  return router.createUrlTree(['/login']);
};
