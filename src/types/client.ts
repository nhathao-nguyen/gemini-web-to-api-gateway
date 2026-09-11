export type AccountStatus =
  | 'ACTIVE'
  | 'COOLDOWN'
  | 'QUOTA_EXHAUSTED'
  | 'SESSION_EXPIRED'
  | 'DISABLED'
  | 'ERROR';

export interface SafeAccount {
  id: string;
  name: string;
  email_label: string;
  auth_user: string;
  status: AccountStatus;
  priority: number;
  weight: number;
  supported_models: string[];
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  cooldown_until: string | null;
  consecutive_errors: number;
  request_count: number;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  key_prefix: string;
  enabled: boolean;
  allowed_models: string[];
  rpm_limit: number;
  concurrent_limit: number;
  daily_request_limit: number;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface AnalyticsData {
  totalRequests: number;
  successfulRequests: number;
  errorRequests: number;
  successRate: number;
  avgLatency: number;
  requestsByModel: Record<string, number>;
  requestsByAccount: Record<string, number>;
  requestsByApiKey: Record<string, number>;
}

export interface RequestLogItem {
  request_id: string;
  api_key_id: string;
  account_id: string;
  model: string;
  status: number;
  latency_ms: number;
  error_code: string | null;
  created_at: string;
}

export interface AccountEventItem {
  id: string;
  account_id: string;
  event_type: string;
  from_status: AccountStatus | null;
  to_status: AccountStatus;
  reason: string;
  created_at: string;
}
