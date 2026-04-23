import { APP_INITIALIZER, ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { environment } from '../environments/environment';
import { credentialsInterceptor } from './core/http-credentials.interceptor';
import { AuthService } from './core/auth.service';

function initLocalhostHtmlClass(): () => void {
  return () => {
    if (environment.devAuthBypass) {
      document.documentElement.classList.add('is-localhost-auth-off');
    }
  };
}

function initAuthRefresh(auth: AuthService): () => Promise<void> {
  return () => auth.refreshMe();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([credentialsInterceptor])),
    { provide: APP_INITIALIZER, useFactory: initLocalhostHtmlClass, multi: true },
    {
      provide: APP_INITIALIZER,
      useFactory: initAuthRefresh,
      deps: [AuthService],
      multi: true,
    },
  ],
};
