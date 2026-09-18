export type HealthStatusLevel = 'healthy' | 'degraded' | 'down' | 'not_configured';

export interface IntegrationHealth {
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
