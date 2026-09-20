export type HealthStatusLevel = 'healthy' | 'degraded' | 'down' | 'not_configured';

export interface IntegrationHealth {
  /** Stable slug for per-provider refresh (`polygon`, `finnhub`, …). */
  id: string;
  name: string;
  key: string;
  status: HealthStatusLevel;
  responseTime?: number;
  lastChecked: string;
  message: string;
  isPaid?: boolean;
}

export interface CategoryHealth {
  name: string;
  critical: boolean;
  integrations: IntegrationHealth[];
}

export interface HealthStatusResponse {
  timestamp: string;
  categories: CategoryHealth[];
}
