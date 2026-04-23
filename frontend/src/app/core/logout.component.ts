import { Component, inject, OnInit } from '@angular/core';
import { AuthService } from './auth.service';

@Component({
  standalone: true,
  template: '',
})
export class LogoutComponent implements OnInit {
  private readonly authSvc = inject(AuthService);

  async ngOnInit(): Promise<void> {
    await this.authSvc.signOutApp();
  }
}
