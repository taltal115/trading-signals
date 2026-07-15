import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { HttpClient } from '@angular/common/http';
import { Subscription, switchMap, of, catchError, map } from 'rxjs';
import { marked } from 'marked';
import {
  ABOUT_DOCS,
  AboutDocEntry,
  docIdToPath,
  docPathToId,
  findAboutDoc,
} from '../../core/docs-catalog';

@Component({
  selector: 'app-about-doc',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './about-doc.component.html',
  styleUrl: './about-doc.component.css',
})
export class AboutDocComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly sanitizer = inject(DomSanitizer);
  private sub: Subscription | null = null;

  readonly doc = signal<AboutDocEntry | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly html = signal<SafeHtml | null>(null);

  ngOnInit(): void {
    marked.setOptions({ gfm: true, breaks: false });
    this.sub = this.route.paramMap
      .pipe(
        switchMap((params) => {
          const rawId = params.get('docId') ?? '';
          const entry = findAboutDoc(rawId);
          if (!entry) {
            this.doc.set(null);
            this.loading.set(false);
            this.error.set(`Unknown document: ${docIdToPath(rawId) || rawId}`);
            this.html.set(null);
            return of(null);
          }
          this.doc.set(entry);
          this.loading.set(true);
          this.error.set('');
          const url = `/repo-docs/${entry.path}`;
          return this.http.get(url, { responseType: 'text' }).pipe(
            map((md) => ({ entry, md })),
            catchError((err) => {
              this.loading.set(false);
              this.error.set(
                err?.status === 404
                  ? `Doc not found at ${url}. Rebuild the frontend so docs are copied into assets.`
                  : `Failed to load ${entry.path}`,
              );
              this.html.set(null);
              return of(null);
            }),
          );
        }),
      )
      .subscribe((got) => {
        if (!got) return;
        const rewritten = rewriteDocLinks(got.md, got.entry.path);
        const parsed = marked.parse(rewritten, { async: false }) as string;
        this.html.set(this.sanitizer.bypassSecurityTrustHtml(parsed));
        this.loading.set(false);
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  prevNext(): { prev: AboutDocEntry | null; next: AboutDocEntry | null } {
    const cur = this.doc();
    if (!cur) return { prev: null, next: null };
    const i = ABOUT_DOCS.findIndex((d) => d.id === cur.id);
    return {
      prev: i > 0 ? ABOUT_DOCS[i - 1] : null,
      next: i >= 0 && i < ABOUT_DOCS.length - 1 ? ABOUT_DOCS[i + 1] : null,
    };
  }
}

/** Rewrite relative ``*.md`` links to in-app About doc routes. */
function rewriteDocLinks(md: string, currentPath: string): string {
  const baseDir = currentPath.includes('/')
    ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1)
    : '';

  return md.replace(/\]\(([^)]+\.md)(#[^)]*)?\)/g, (_m, rel: string, hash: string = '') => {
    let target = rel.trim();
    if (target.startsWith('http://') || target.startsWith('https://')) {
      return `](${rel}${hash})`;
    }
    if (target.startsWith('../')) {
      // From docs/foo/bar.md, ../x.md → docs/x.md
      const parts = (baseDir + target).split('/');
      const out: string[] = [];
      for (const p of parts) {
        if (p === '..') out.pop();
        else if (p && p !== '.') out.push(p);
      }
      target = out.join('/');
    } else if (target.startsWith('./')) {
      target = baseDir + target.slice(2);
    } else if (!target.includes('/') && baseDir) {
      target = baseDir + target;
    }
    // Strip leading docs/ if present in link style like docs/foo.md from repo-root links
    if (target.startsWith('docs/')) target = target.slice(5);
    const id = docPathToId(target);
    return `](/about/docs/${id}${hash})`;
  });
}
