import { db } from '../db/database.js';
import { RequestLog } from '../types.js';

export class UsageService {
  public logRequest(log: RequestLog) {
    db.addRequestLog(log);
  }

  public getRecentLogs(limit = 100): RequestLog[] {
    return db.getRequestLogs(limit);
  }

  public getAnalytics() {
    return db.getAnalytics();
  }
}

export const usageService = new UsageService();
