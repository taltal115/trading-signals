import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { aboutDocsByCategory } from '../../core/docs-catalog';

@Component({
  selector: 'app-about-index',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './about-index.component.html',
  styleUrl: './about-index.component.css',
})
export class AboutIndexComponent {
  readonly groups = aboutDocsByCategory();
}
