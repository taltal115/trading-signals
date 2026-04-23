import { HttpInterceptorFn } from '@angular/common/http';

/** Session cookie auth requires credentialed requests to the API (same-origin or CORS). */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) =>
  next(req.clone({ withCredentials: true }));
