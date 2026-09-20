import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export type NewsArticlesProvider = 'finnhub' | 'newsapi' | 'gdelt';

export interface NewsArticleItem {
  title: string;
  url: string;
  source?: string;
  publishedAt?: string;
}

export interface NewsArticlesResponse {
  ticker: string;
  provider: NewsArticlesProvider;
  articles: NewsArticleItem[];
  browseUrl?: string;
  message?: string;
}

@Injectable()
export class NewsArticlesService {
  constructor(private readonly config: ConfigService) {}

  async listArticles(
    tickerRaw: string,
    providerRaw: string,
  ): Promise<NewsArticlesResponse> {
    const ticker = String(tickerRaw || '')
      .trim()
      .toUpperCase();
    const provider = String(providerRaw || '')
      .trim()
      .toLowerCase() as NewsArticlesProvider;
    if (!ticker) {
      throw new BadRequestException('ticker is required');
    }
    if (!['finnhub', 'newsapi', 'gdelt'].includes(provider)) {
      throw new BadRequestException('provider must be finnhub, newsapi, or gdelt');
    }

    if (provider === 'finnhub') {
      return this.fetchFinnhub(ticker);
    }
    if (provider === 'newsapi') {
      return this.fetchNewsApi(ticker);
    }
    return this.fetchGdelt(ticker);
  }

  private browseUrls(ticker: string): Record<NewsArticlesProvider, string> {
    const q = encodeURIComponent(ticker);
    return {
      finnhub: `https://finnhub.io/quote/${q}`,
      newsapi: `https://news.google.com/search?q=${encodeURIComponent(ticker + ' stock')}`,
      gdelt: `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&maxrecords=25&sort=DateDesc&format=html`,
    };
  }

  private async fetchFinnhub(ticker: string): Promise<NewsArticlesResponse> {
    const browseUrl = this.browseUrls(ticker).finnhub;
    const apiKey = (
      this.config.get<string>('FINNHUB_API_KEY') ||
      process.env.FINNHUB_API_KEY ||
      ''
    ).trim();
    if (!apiKey) {
      return {
        ticker,
        provider: 'finnhub',
        articles: [],
        browseUrl,
        message: 'FINNHUB_API_KEY not configured',
      };
    }
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);
    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    try {
      const url = 'https://finnhub.io/api/v1/company-news';
      const { data } = await axios.get(url, {
        params: { symbol: ticker, from, to, token: apiKey },
        timeout: 12_000,
      });
      const rows = Array.isArray(data) ? data : [];
      const articles: NewsArticleItem[] = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const o = row as Record<string, unknown>;
        const title = String(o['headline'] || o['title'] || '').trim();
        const link = String(o['url'] || '').trim();
        if (!title || !link) continue;
        const ts = o['datetime'];
        let publishedAt: string | undefined;
        if (typeof ts === 'number' && Number.isFinite(ts)) {
          publishedAt = new Date(ts * 1000).toISOString();
        }
        articles.push({
          title,
          url: link,
          source: String(o['source'] || '').trim() || undefined,
          publishedAt,
        });
        if (articles.length >= 12) break;
      }
      return { ticker, provider: 'finnhub', articles, browseUrl };
    } catch (e) {
      return {
        ticker,
        provider: 'finnhub',
        articles: [],
        browseUrl,
        message: e instanceof Error ? e.message.slice(0, 120) : 'Finnhub request failed',
      };
    }
  }

  private async fetchNewsApi(ticker: string): Promise<NewsArticlesResponse> {
    const browseUrl = this.browseUrls(ticker).newsapi;
    const apiKey = (
      this.config.get<string>('NEWSAPI_API_KEY') ||
      process.env.NEWSAPI_API_KEY ||
      ''
    ).trim();
    if (!apiKey) {
      return {
        ticker,
        provider: 'newsapi',
        articles: [],
        browseUrl,
        message: 'NEWSAPI_API_KEY not configured',
      };
    }
    try {
      const { data } = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: ticker,
          language: 'en',
          sortBy: 'publishedAt',
          pageSize: 12,
          apiKey,
        },
        timeout: 12_000,
      });
      const rows = Array.isArray(data?.articles) ? data.articles : [];
      const articles: NewsArticleItem[] = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const o = row as Record<string, unknown>;
        const title = String(o['title'] || '').trim();
        const link = String(o['url'] || '').trim();
        if (!title || title.toLowerCase() === '[removed]' || !link) continue;
        const source =
          o['source'] && typeof o['source'] === 'object'
            ? String((o['source'] as Record<string, unknown>)['name'] || '').trim()
            : '';
        articles.push({
          title,
          url: link,
          source: source || undefined,
          publishedAt: String(o['publishedAt'] || '').trim() || undefined,
        });
        if (articles.length >= 12) break;
      }
      return { ticker, provider: 'newsapi', articles, browseUrl };
    } catch (e) {
      return {
        ticker,
        provider: 'newsapi',
        articles: [],
        browseUrl,
        message: e instanceof Error ? e.message.slice(0, 120) : 'NewsAPI request failed',
      };
    }
  }

  private async fetchGdelt(ticker: string): Promise<NewsArticlesResponse> {
    const browseUrl = this.browseUrls(ticker).gdelt;
    try {
      const { data } = await axios.get(
        'https://api.gdeltproject.org/api/v2/doc/doc',
        {
          params: {
            query: ticker,
            mode: 'ArtList',
            format: 'json',
            sort: 'DateDesc',
            maxrecords: 12,
          },
          timeout: 15_000,
        },
      );
      const rows = Array.isArray(data?.articles) ? data.articles : [];
      const articles: NewsArticleItem[] = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const o = row as Record<string, unknown>;
        const title = String(o['title'] || '').trim();
        const link = String(o['url'] || '').trim();
        if (!title || !link) continue;
        articles.push({
          title,
          url: link,
          source: String(o['domain'] || '').trim() || undefined,
          publishedAt: String(o['seendate'] || '').trim() || undefined,
        });
        if (articles.length >= 12) break;
      }
      return { ticker, provider: 'gdelt', articles, browseUrl };
    } catch (e) {
      return {
        ticker,
        provider: 'gdelt',
        articles: [],
        browseUrl,
        message: e instanceof Error ? e.message.slice(0, 120) : 'GDELT request failed',
      };
    }
  }
}
