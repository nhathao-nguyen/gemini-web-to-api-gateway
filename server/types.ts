export type AccountStatus =
  | 'ACTIVE'
  | 'COOLDOWN'
  | 'QUOTA_EXHAUSTED'
  | 'SESSION_EXPIRED'
  | 'DISABLED'
  | 'ERROR';

export type KeepAliveStatus = 'IDLE' | 'REFRESHING' | 'SUCCESS' | 'FAILED';

export interface GeminiAccount {
  id: string;
  name: string;
  email_label: string;
  encrypted_cookie: string;
  auth_user: string;
  status: AccountStatus;
  priority: number;
  weight: number;
  supported_models: string[];
  proxy_url?: string | null;
  profile_dir?: string | null;
  user_agent?: string | null;
  locale?: string | null;
  timezone?: string | null;
  last_keepalive_at?: string | null;
  keepalive_status?: KeepAliveStatus | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  cooldown_until: string | null;
  consecutive_errors: number;
  request_count: number;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  enabled: boolean;
  allowed_models: string[];
  rpm_limit: number;
  concurrent_limit: number;
  daily_request_limit: number;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface RequestLog {
  request_id: string;
  api_key_id: string;
  account_id: string;
  model: string;
  status: number;
  latency_ms: number;
  error_code: string | null;
  created_at: string;
}

export interface AccountEvent {
  id: string;
  account_id: string;
  event_type: string;
  from_status: AccountStatus | null;
  to_status: AccountStatus;
  reason: string;
  created_at: string;
}

export interface UploadedFileRecord {
  id: string;
  account_id: string;
  name: string;
  mime_type: string;
  size: number;
  created_at: string;
  expires_at: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
}

export interface AccountQuotaInfo {
  tier: string;
  current_usage_percent: number;
  current_reset_at: string;
  current_reset_label: string;
  weekly_usage_percent: number;
  weekly_reset_at: string;
  weekly_reset_label: string;
  fetched_at: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: any[];
  tool_choice?: any;
  response_format?: { type: 'text' | 'json_object' };
  conversation_id?: string;
  upstream_cid?: string;
  upstream_rid?: string;
  upstream_rcid?: string;
  uploaded_files?: Array<{ id: string; name: string }>;
  thinking?: boolean;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'none';
}


export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
  };
  finish_reason: 'stop' | 'length' | 'content_filter' | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated?: boolean;
  };
  system_fingerprint?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string;
  };
  finish_reason: 'stop' | 'length' | 'content_filter' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface HealthResult {
  valid: boolean;
  error?: string;
  statusCode?: number;
  models?: string[];
  accountStatus: AccountStatus;
}

export interface GeneratedMedia {
  url: string;
  title?: string;
  mime_type: string;
  width?: number;
  height?: number;
  b64_json?: string;
}

export interface ModelCapabilities {
  text: boolean;
  vision: boolean;
  files: boolean;
  thinking: boolean;
  image_generation: boolean;
  video_generation: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  account_id: string;
  upstream_cid?: string;
  upstream_rid?: string;
  upstream_rcid?: string;
  api_key_id: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning_content?: string;
  attachments?: Array<{ name: string; mime_type: string; url?: string; id?: string }>;
  generated_media?: GeneratedMedia[];
  created_at: string;
}

export interface MediaCache {
  id: string;
  account_id: string;
  upstream_url: string;
  mime_type: string;
  file_name: string;
  data_b64: string;
  created_at: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  response_format?: 'url' | 'b64_json';
}

export interface AIProviderResult {
  text: string;
  reasoning_content?: string;
  conversation_id?: string;
  response_id?: string;
  choice_id?: string;
  images?: GeneratedMedia[];
  prompt_tokens: number;
  completion_tokens: number;
}

export interface AIStreamChunk {
  text_delta: string;
  reasoning_delta?: string;
  is_done: boolean;
  conversation_id?: string;
  response_id?: string;
  choice_id?: string;
  images?: GeneratedMedia[];
}

export interface UpstreamConversation {
  id: string; // c_...
  title: string;
  updated_at: string;
  timestamp_seconds?: number;
  choice_id?: string; // rc_...
}

export interface UpstreamChatTurn {
  role: 'user' | 'assistant';
  content: string;
  reasoning_content?: string;
  choice_id?: string;
  response_id?: string;
  timestamp?: number;
}

export interface AIProvider {
  ListModels(account: GeminiAccount): Promise<string[]>;
  ValidateSession(account: GeminiAccount): Promise<HealthResult>;
  ChatCompletion(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    deadline?: number
  ): Promise<AIProviderResult>;
  ChatCompletionStream(
    account: GeminiAccount,
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    deadline?: number
  ): AsyncIterable<AIStreamChunk>;
  getAccountQuota?(account: GeminiAccount, signal?: AbortSignal, deadline?: number): Promise<AccountQuotaInfo>;
}


