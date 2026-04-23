import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import { AuthService } from './auth.service';

/** Redirect session users away from /login. */
export const loginGuard: CanActivateFn = async () => {
  const authSvc = inject(AuthService);
  const router = inject(Router);
  if (authSvc.devAuthBypass) return router.createUrlTree(['/dashboard']);
  await authSvc.refreshMe();
  const u = await firstValueFrom(authSvc.user$.pipe(take(1)));
  if (u && authSvc.isAllowed(u)) return router.createUrlTree(['/dashboard']);
  return true;
};
