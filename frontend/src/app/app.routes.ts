import { Routes } from '@angular/router';
import { shellGuard } from './core/shell.guard';
import { loginGuard } from './core/login.guard';

export const routes: Routes = [
  {
    path: 'logout',
    loadComponent: () => import('./core/logout.component').then((m) => m.LogoutComponent),
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./layout/login-page/login-page.component').then((m) => m.LoginPageComponent),
    canActivate: [loginGuard],
  },
  {
    path: '',
    loadComponent: () => import('./layout/app-shell/app-shell.component').then((m) => m.AppShellComponent),
    canActivate: [shellGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'universe',
        loadComponent: () =>
          import('./features/universe-page/universe-page.component').then((m) => m.UniversePageComponent),
      },
      {
        path: 'signals',
        loadComponent: () =>
          import('./features/signals-page/signals-page.component').then((m) => m.SignalsPageComponent),
      },
      {
        path: 'positions',
        loadComponent: () =>
          import('./features/positions-page/positions-page.component').then((m) => m.PositionsPageComponent),
      },
      {
        path: 'reporting',
        loadComponent: () =>
          import('./features/reporting-page/reporting-page.component').then((m) => m.ReportingPageComponent),
      },
      {
        path: 'monitor',
        loadComponent: () =>
          import('./features/monitor-page/monitor-page.component').then((m) => m.MonitorPageComponent),
      },
      {
        path: 'about',
        loadComponent: () =>
          import('./features/about-index/about-index.component').then((m) => m.AboutIndexComponent),
      },
      {
        path: 'about/run',
        loadComponent: () =>
          import('./features/about-run/about-run.component').then((m) => m.AboutRunComponent),
      },
      {
        path: 'about/universe',
        loadComponent: () =>
          import('./features/about-universe/about-universe.component').then((m) => m.AboutUniverseComponent),
      },
      {
        path: 'about/monitor',
        loadComponent: () =>
          import('./features/about-monitor/about-monitor.component').then((m) => m.AboutMonitorComponent),
      },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
