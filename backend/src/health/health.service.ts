import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { IntegrationHealth, CategoryHealth, HealthStatusResponse } from './dto/health-status.dto';
import { FirestoreService } from '../firebase/firestore.service';
import * as fs from 'fs';
import * as path from 'path';

type ProviderCheckId =
  | 'polygon'
  | 'yahoo'
  | 'stooq'
  | 'finnhub'
  | 'newsapi'
  | 'gdelt'
  | 'openai'
  | 'fred'
  | 'firestore'
  | 'sqlite'
  | 'slack'
  | 'ibkr';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly CHECK_TIMEOUT = 5000; // 5 seconds

  constructor(
    private readonly config: ConfigService,
    private readonly firestore: FirestoreService,
  ) {}

  async getHealthStatus(): Promise<HealthStatusResponse> {
    const timestamp = new Date().toISOString();

    const categories: CategoryHealth[] = [
      await this.checkMarketDataCategory(),
      await this.checkNewsCategory(),
      await this.checkAICategory(),
      await this.checkMacroCategory(),
      await this.checkDatabaseCategory(),
      await this.checkMessagingCategory(),
      await this.checkBrokerCategory(),
    ];

    return { timestamp, categories };
  }

  /** Re-check one provider (Health page per-row Refresh). */
  async getIntegrationHealth(rawId: string): Promise<IntegrationHealth> {
    const id = String(rawId || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    const checkers: Record<ProviderCheckId, () => Promise<IntegrationHealth>> = {
      polygon: () => this.checkPolygon(),
      yahoo: () => this.checkYahoo(),
      stooq: () => this.checkStooq(),
      finnhub: () => this.checkFinnhub(),
      newsapi: () => this.checkNewsAPI(),
      gdelt: () => this.checkGDELT(),
      openai: () => this.checkOpenAI(),
      fred: () => this.checkFRED(),
      firestore: () => this.checkFirestore(),
      sqlite: () => this.checkSQLite(),
      slack: () => this.checkSlack(),
      ibkr: () => this.checkIBKR(),
    };
    const run = checkers[id as ProviderCheckId];
    if (!run) {
      throw new NotFoundException(`Unknown health provider: ${rawId}`);
    }
    return run();
  }

  private async checkMarketDataCategory(): Promise<CategoryHealth> {
    const integrations = await Promise.all([
      this.checkPolygon(),
      this.checkYahoo(),
      this.checkStooq(),
    ]);

    return {
      name: 'Market Data',
      critical: true,
      integrations,
    };
  }

  private async checkNewsCategory(): Promise<CategoryHealth> {
    const integrations = await Promise.all([
      this.checkFinnhub(),
      this.checkNewsAPI(),
      this.checkGDELT(),
    ]);

    return {
      name: 'News & Research',
      critical: false,
      integrations,
    };
  }

  private async checkAICategory(): Promise<CategoryHealth> {
    const integrations = await Promise.all([this.checkOpenAI()]);

    return {
      name: 'AI & ML',
      critical: true,
      integrations,
    };
  }

  private async checkMacroCategory(): Promise<CategoryHealth> {
    const integrations = await Promise.all([this.checkFRED()]);

    return {
      name: 'Macro & Economic',
      critical: false,
      integrations,
    };
  }

  private async checkDatabaseCategory(): Promise<CategoryHealth> {
    const integrations = await Promise.all([
      this.checkFirestore(),
      this.checkSQLite(),
    ]);

    return {
      name: 'Database & Storage',
      critical: true,
      integrations,
    };
  }

  private async checkMessagingCategory(): Promise<CategoryHealth> {
    const integrations = await Promise.all([this.checkSlack()]);

    return {
      name: 'Messaging & Notifications',
      critical: false,
      integrations,
    };
  }

  private async checkBrokerCategory(): Promise<CategoryHealth> {
    const integrations = await Promise.all([this.checkIBKR()]);

    return {
      name: 'Broker & Portfolio',
      critical: false,
      integrations,
    };
  }

  private envKey(...names: string[]): string {
    for (const name of names) {
      const v = (this.config.get<string>(name) || '').trim();
      if (v) return v;
    }
    return '';
  }

  private polygonKey(): string {
    // Massive.io is the Polygon rebrand — one key, either env name.
    return this.envKey('POLYGON_API_KEY', 'MASSIVE_API_KEY', 'polygonApiKey');
  }

  private async checkPolygon(): Promise<IntegrationHealth> {
    const apiKey = this.polygonKey();

    if (!apiKey) {
      return this.notConfigured('polygon', 'Polygon / Massive', 'POLYGON_API_KEY', true);
    }

    const start = Date.now();
    try {
      const url = `https://api.polygon.io/v2/aggs/ticker/AAPL/prev?apiKey=${apiKey}`;
      const response = await axios.get(url, { timeout: this.CHECK_TIMEOUT });
      const responseTime = Date.now() - start;

      if (response.status === 200 && response.data?.results) {
        return this.healthy(
          'polygon',
          'Polygon / Massive',
          'POLYGON_API_KEY',
          responseTime,
          true,
        );
      }

      return this.down(
        'polygon',
        'Polygon / Massive',
        'POLYGON_API_KEY',
        'Invalid response',
        true,
      );
    } catch (error) {
      return this.handleError(
        'polygon',
        'Polygon / Massive',
        'POLYGON_API_KEY',
        error as Error,
        true,
      );
    }
  }

  private async checkYahoo(): Promise<IntegrationHealth> {
    const start = Date.now();
    try {
      const url =
        'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d';
      const response = await axios.get(url, { timeout: this.CHECK_TIMEOUT });
      const responseTime = Date.now() - start;

      if (response.status === 200 && response.data?.chart?.result) {
        return this.healthy('yahoo', 'Yahoo Finance', 'None (Free)', responseTime);
      }

      return this.down('yahoo', 'Yahoo Finance', 'None (Free)', 'Invalid response');
    } catch (error) {
      return this.handleError('yahoo', 'Yahoo Finance', 'None (Free)', error as Error);
    }
  }

  private async checkStooq(): Promise<IntegrationHealth> {
    const start = Date.now();
    try {
      const url = 'https://stooq.com/q/d/l/?s=aapl.us&i=d';
      const response = await axios.get(url, { timeout: this.CHECK_TIMEOUT });
      const responseTime = Date.now() - start;

      if (response.status === 200 && response.data) {
        return this.healthy('stooq', 'Stooq', 'None (Free)', responseTime);
      }

      return this.down('stooq', 'Stooq', 'None (Free)', 'Invalid response');
    } catch (error) {
      return this.handleError('stooq', 'Stooq', 'None (Free)', error as Error);
    }
  }

  private async checkFinnhub(): Promise<IntegrationHealth> {
    const apiKey = this.config.get<string>('FINNHUB_API_KEY');

    if (!apiKey || apiKey.trim() === '') {
      return this.notConfigured('finnhub', 'Finnhub', 'FINNHUB_API_KEY');
    }

    const start = Date.now();
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${apiKey}`;
      const response = await axios.get(url, { timeout: this.CHECK_TIMEOUT });
      const responseTime = Date.now() - start;

      if (response.status === 200 && response.data?.c !== undefined) {
        return this.healthy('finnhub', 'Finnhub', 'FINNHUB_API_KEY', responseTime);
      }

      return this.down('finnhub', 'Finnhub', 'FINNHUB_API_KEY', 'Invalid response');
    } catch (error) {
      return this.handleError('finnhub', 'Finnhub', 'FINNHUB_API_KEY', error as Error);
    }
  }

  private async checkNewsAPI(): Promise<IntegrationHealth> {
    const apiKey = this.config.get<string>('NEWSAPI_API_KEY');

    if (!apiKey || apiKey.trim() === '') {
      return this.notConfigured('newsapi', 'NewsAPI', 'NEWSAPI_API_KEY');
    }

    const start = Date.now();
    try {
      const url = `https://newsapi.org/v2/everything?q=AAPL&pageSize=1&apiKey=${apiKey}`;
      const response = await axios.get(url, { timeout: this.CHECK_TIMEOUT });
      const responseTime = Date.now() - start;

      if (response.status === 200 && response.data?.status === 'ok') {
        return this.healthy('newsapi', 'NewsAPI', 'NEWSAPI_API_KEY', responseTime);
      }

      return this.down('newsapi', 'NewsAPI', 'NEWSAPI_API_KEY', 'Invalid response');
    } catch (error) {
      return this.handleError('newsapi', 'NewsAPI', 'NEWSAPI_API_KEY', error as Error);
    }
  }

  private async checkGDELT(): Promise<IntegrationHealth> {
    const start = Date.now();
    try {
      const url =
        'https://api.gdeltproject.org/api/v2/doc/doc?query=AAPL&mode=ArtList&maxrecords=1&format=json';
      const response = await axios.get(url, { timeout: 12_000 });
      const responseTime = Date.now() - start;

      if (response.status === 200) {
        return this.healthy('gdelt', 'GDELT', 'None (Free)', responseTime);
      }

      return this.down('gdelt', 'GDELT', 'None (Free)', 'Invalid response');
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      let message = 'Public API unavailable — Finnhub still supplies news';
      if (axiosError.code === 'ECONNABORTED') {
        message = 'Public API timed out — Finnhub still supplies news';
      } else if (status === 429) {
        message = 'Public API rate-limited — Finnhub still supplies news';
      }
      return {
        id: 'gdelt',
        name: 'GDELT',
        key: 'None (Free)',
        status: 'degraded',
        responseTime: Date.now() - start,
        lastChecked: new Date().toISOString(),
        message,
      };
    }
  }

  private async checkOpenAI(): Promise<IntegrationHealth> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');

    if (!apiKey || apiKey.trim() === '') {
      return this.notConfigured('openai', 'OpenAI', 'OPENAI_API_KEY', true);
    }

    const start = Date.now();
    try {
      const url = 'https://api.openai.com/v1/models';
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: this.CHECK_TIMEOUT,
      });
      const responseTime = Date.now() - start;

      if (response.status === 200 && response.data?.data) {
        return this.healthy('openai', 'OpenAI', 'OPENAI_API_KEY', responseTime, true);
      }

      return this.down('openai', 'OpenAI', 'OPENAI_API_KEY', 'Invalid response', true);
    } catch (error) {
      return this.handleError('openai', 'OpenAI', 'OPENAI_API_KEY', error as Error, true);
    }
  }

  private async checkFRED(): Promise<IntegrationHealth> {
    const apiKey = this.config.get<string>('FRED_API_KEY');

    if (!apiKey || apiKey.trim() === '') {
      return this.notConfigured('fred', 'FRED', 'FRED_API_KEY');
    }

    const start = Date.now();
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DFF&api_key=${apiKey}&limit=1&file_type=json`;
      const response = await axios.get(url, { timeout: this.CHECK_TIMEOUT });
      const responseTime = Date.now() - start;

      if (response.status === 200 && response.data?.observations) {
        return this.healthy('fred', 'FRED', 'FRED_API_KEY', responseTime);
      }

      return this.down('fred', 'FRED', 'FRED_API_KEY', 'Invalid response');
    } catch (error) {
      return this.handleError('fred', 'FRED', 'FRED_API_KEY', error as Error);
    }
  }

  private async checkFirestore(): Promise<IntegrationHealth> {
    const start = Date.now();
    try {
      await this.firestore.listSignals(1);
      const responseTime = Date.now() - start;

      return this.healthy(
        'firestore',
        'Firestore',
        'GOOGLE_APPLICATION_CREDENTIALS',
        responseTime,
      );
    } catch (error) {
      return this.handleError(
        'firestore',
        'Firestore',
        'GOOGLE_APPLICATION_CREDENTIALS',
        error as Error,
      );
    }
  }

  private async checkSQLite(): Promise<IntegrationHealth> {
    const start = Date.now();
    try {
      const dbPath = this.config.get<string>('sqlite.path', './data/signals.db');
      const fullPath = path.resolve(process.cwd(), '..', dbPath);

      if (fs.existsSync(fullPath)) {
        const responseTime = Date.now() - start;
        return this.healthy('sqlite', 'SQLite', 'None (Local)', responseTime);
      }

      return {
        id: 'sqlite',
        name: 'SQLite',
        key: 'None (Local)',
        status: 'degraded',
        responseTime: Date.now() - start,
        lastChecked: new Date().toISOString(),
        message: 'Database file not found',
      };
    } catch (error) {
      return this.handleError('sqlite', 'SQLite', 'None (Local)', error as Error);
    }
  }

  private async checkSlack(): Promise<IntegrationHealth> {
    const token = this.config.get<string>('SLACK_BOT_TOKEN');

    if (!token || token.trim() === '') {
      return this.notConfigured('slack', 'Slack', 'SLACK_BOT_TOKEN');
    }

    const start = Date.now();
    try {
      const url = 'https://slack.com/api/auth.test';
      const response = await axios.post(
        url,
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: this.CHECK_TIMEOUT,
        },
      );
      const responseTime = Date.now() - start;

      if (response.status === 200 && response.data?.ok) {
        return this.healthy('slack', 'Slack', 'SLACK_BOT_TOKEN', responseTime);
      }

      return this.down('slack', 'Slack', 'SLACK_BOT_TOKEN', 'Token validation failed');
    } catch (error) {
      return this.handleError('slack', 'Slack', 'SLACK_BOT_TOKEN', error as Error);
    }
  }

  private async checkIBKR(): Promise<IntegrationHealth> {
    const enabled = this.config.get<boolean>('ibkr.client_portal.enabled', false);

    if (!enabled) {
      return {
        id: 'ibkr',
        name: 'IBKR Client Portal',
        key: 'IBKR Config',
        status: 'not_configured',
        lastChecked: new Date().toISOString(),
        message: 'Client Portal disabled in config',
      };
    }

    const baseUrl = this.config.get<string>(
      'ibkr.client_portal.base_url',
      'https://localhost:5000/v1/api',
    );
    const start = Date.now();

    try {
      const url = `${baseUrl}/portfolio/accounts`;
      const response = await axios.get(url, {
        timeout: this.CHECK_TIMEOUT,
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
      });
      const responseTime = Date.now() - start;

      if (response.status === 200) {
        return this.healthy('ibkr', 'IBKR Client Portal', 'IBKR Config', responseTime);
      }

      return this.down('ibkr', 'IBKR Client Portal', 'IBKR Config', 'Invalid response');
    } catch (error) {
      return this.handleError('ibkr', 'IBKR Client Portal', 'IBKR Config', error as Error);
    }
  }

  private healthy(
    id: string,
    name: string,
    key: string,
    responseTime: number,
    isPaid = false,
  ): IntegrationHealth {
    return {
      id,
      name,
      key,
      status: 'healthy',
      responseTime,
      lastChecked: new Date().toISOString(),
      message: 'OK',
      isPaid,
    };
  }

  private down(
    id: string,
    name: string,
    key: string,
    message: string,
    isPaid = false,
  ): IntegrationHealth {
    return {
      id,
      name,
      key,
      status: 'down',
      lastChecked: new Date().toISOString(),
      message,
      isPaid,
    };
  }

  private notConfigured(
    id: string,
    name: string,
    key: string,
    isPaid = false,
  ): IntegrationHealth {
    return {
      id,
      name,
      key,
      status: 'not_configured',
      lastChecked: new Date().toISOString(),
      message: 'API key not configured',
      isPaid,
    };
  }

  private handleError(
    id: string,
    name: string,
    key: string,
    error: Error,
    isPaid = false,
  ): IntegrationHealth {
    const axiosError = error as AxiosError;
    let message = 'Connection failed';

    if (axiosError.code === 'ECONNABORTED') {
      message = 'Request timeout';
    } else if (axiosError.response?.status === 401 || axiosError.response?.status === 403) {
      message = 'Authentication failed';
    } else if (axiosError.response?.status === 429) {
      message = 'Rate limited';
    } else if (axiosError.message) {
      message = axiosError.message.substring(0, 100);
    }

    this.logger.warn(`Health check failed for ${name}: ${message}`);

    return {
      id,
      name,
      key,
      status: 'down',
      lastChecked: new Date().toISOString(),
      message,
      isPaid,
    };
  }
}
