import crypto from 'crypto';
import { db } from '../db/database.js';
import { AccountStatus } from '../types.js';
import { geminiProvider } from './gemini-adapter/index.js';

export class QuotaManager {
  /**
   * Handle successful request completion on an account
   */
  public recordSuccess(accountId: string) {
    db.recordAccountSuccess(accountId);
  }

  /**
   * Handle upstream error and adapt account state accordingly
   */
  public recordError(accountId: string, error: Error | string) {
    const account = db.getAccountById(accountId);
    if (!account) return;

    const errMsg = typeof error === 'string' ? error : error.message;

    // Ignore client-induced cancellations/aborts - do not penalize account
    if (
      errMsg.includes('AbortError') ||
      errMsg.includes('This operation was aborted') ||
      errMsg.includes('ERR_ABORTED') ||
      errMsg.includes('The user aborted a request') ||
      errMsg.includes('CLIENT_ABORT') ||
      errMsg.includes('aborted by client')
    ) {
      return;
    }

    const now = new Date();
    const consecutive = account.consecutive_errors + 1;
    let newStatus: AccountStatus = account.status;
    let cooldownUntil: string | null = null;
    let reason = errMsg;

    if (errMsg.includes('SESSION_EXPIRED') || errMsg.includes('upstream_auth_expired')) {
      newStatus = 'SESSION_EXPIRED';
      reason = 'Google Gemini session invalid or expired';
      geminiProvider.invalidateSession(accountId);
    } else if (errMsg.includes('QUOTA_EXHAUSTED') || errMsg.includes('429')) {
      newStatus = 'QUOTA_EXHAUSTED';
      // Cooldown for 15 minutes on quota exhaustion
      const cooldownDate = new Date(now.getTime() + 15 * 60 * 1000);
      cooldownUntil = cooldownDate.toISOString();
      reason = 'Upstream quota limit exceeded';
    } else {
      // Temporary network or upstream error
      if (consecutive >= 3) {
        newStatus = 'COOLDOWN';
        // Short cooldown 3 minutes
        const cooldownDate = new Date(now.getTime() + 3 * 60 * 1000);
        cooldownUntil = cooldownDate.toISOString();
        reason = `Repeated upstream errors (${consecutive} consecutive)`;
      } else {
        // Keep current status (ACTIVE) for isolated transient or client-induced errors
        newStatus = account.status;
        reason = `Transient error: ${errMsg}`;
      }
    }

    db.updateAccount(accountId, {
      status: newStatus,
      consecutive_errors: consecutive,
      last_error: errMsg,
      last_error_at: now.toISOString(),
      cooldown_until: cooldownUntil,
    });

    db.addAccountEvent({
      id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      account_id: accountId,
      event_type: 'ERROR_RECORDED',
      from_status: account.status,
      to_status: newStatus,
      reason,
      created_at: now.toISOString(),
    });
  }

  /**
   * Check whether an account is currently in cooldown
   */
  public isCoolingDown(account: { status: AccountStatus; cooldown_until: string | null }): boolean {
    if (account.status === 'COOLDOWN' || account.status === 'QUOTA_EXHAUSTED') {
      if (account.cooldown_until) {
        const cooldownTime = new Date(account.cooldown_until).getTime();
        if (Date.now() < cooldownTime) {
          return true;
        }
      } else {
        return true;
      }
    }
    return false;
  }
}

export const quotaManager = new QuotaManager();
