export interface ApiKeyRecord {
  id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  budget_usd_monthly: string;
  budget_mode: "hard_stop" | "soft_warn";
  requests_per_minute: number;
  tokens_per_minute: number;
  created_at: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyRecord;
    }
  }
}
