import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from '../db/database.js';
import { quotaManager } from '../services/quota-manager.js';
import { apiKeyManager } from '../services/api-key-manager.js';
import { gatewayService } from '../services/gateway-service.js';
import { geminiProvider } from '../services/gemini-adapter/index.js';
import { GeminiWebProvider } from '../services/gemini-adapter/gemini-web.js';
import { GeminiAccount, ApiKey, ChatCompletionRequest } from '../types.js';

let regressionPassed = 0;
let regressionFailed = 0;

function assert(condition: boolean, testName: string, detail?: any) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    regressionPassed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}`, detail || '');
    regressionFailed++;
  }
}

export async function runRegressionTests() {
  console.log('\n========================================');
  console.log('🧪 Running Regression Test Suite (11 Requirements)');
  console.log('========================================\n');

  // Test 1: Plaintext API key not written to browser storage
  console.log('--- Test 1: Plaintext Gateway API Key Browser Storage Audit ---');
  const srcDir = path.resolve(process.cwd(), 'src');
  const filesToCheck: string[] = [];

  function collectTsxFiles(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectTsxFiles(fullPath);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        filesToCheck.push(fullPath);
      }
    }
  }
  collectTsxFiles(srcDir);

  let foundStorageKey = false;
  for (const file of filesToCheck) {
    const content = fs.readFileSync(file, 'utf-8');
    if (
      content.includes('localStorage.setItem') && content.includes('gmgw_playground_key') ||
      content.includes('sessionStorage.setItem') && content.includes('gmgw_playground_key') ||
      content.includes('localStorage.getItem(\'gmgw_playground_key\')') ||
      content.includes('sessionStorage.getItem(\'gmgw_playground_key\')')
    ) {
      foundStorageKey = true;
      console.error(`Found storage leak in: ${file}`);
    }
  }
  assert(!foundStorageKey, 'No localStorage or sessionStorage usage of gmgw_playground_key in src/');

  // Test 2: Image generation model permission & fallback
  console.log('\n--- Test 2: Image Generation Model Permission & Fallback ---');
  const restrictedApiKey: ApiKey = {
    id: `key_regression_${Date.now()}`,
    name: 'Restricted Image Key',
    key_prefix: 'sk-gmgw-regr1234',
    key_hash: 'hash_regr_1',
    allowed_models: ['gemini-2.5-flash'], // Only flash allowed, NOT pro
    rpm_limit: 60,
    concurrent_limit: 10,
    daily_request_limit: 1000,
    created_at: new Date().toISOString(),
    expires_at: null,
    enabled: true,
    last_used_at: null,
  };

  try {
    await gatewayService.handleImageGeneration(
      {
        prompt: 'A beautiful sunset',
        model: 'gemini-2.5-pro', // Disallowed model
      },
      restrictedApiKey,
      'req_test_img_1'
    );
    assert(false, 'Image generation throws MODEL_NOT_ALLOWED for disallowed model');
  } catch (err: any) {
    assert(
      err.message.includes('MODEL_NOT_ALLOWED'),
      'Image generation rejects disallowed model with MODEL_NOT_ALLOWED',
      err.message
    );
  }

  // Test 3: Uploaded file account affinity
  console.log('\n--- Test 3: Uploaded File Account Affinity ---');
  const now = new Date().toISOString();
  const fileAccA: GeminiAccount = {
    id: 'acc_file_test_a',
    name: 'File Affinity Account A',
    email_label: 'file_a@example.com',
    encrypted_cookie: 'dummy:cookie:enc',
    auth_user: '0',
    status: 'ACTIVE',
    priority: 10,
    weight: 1,
    supported_models: ['gemini-2.5-flash'],
    profile_dir: '',
    user_agent: '',
    locale: 'en-US',
    timezone: 'UTC',
    last_keepalive_at: now,
    keepalive_status: 'IDLE',
    last_success_at: now,
    last_error_at: null,
    last_error: null,
    cooldown_until: null,
    consecutive_errors: 0,
    request_count: 0,
    created_at: now,
    updated_at: now,
  };

  const fileAccB: GeminiAccount = {
    id: 'acc_file_test_b',
    name: 'File Affinity Account B',
    email_label: 'file_b@example.com',
    encrypted_cookie: 'dummy:cookie:enc',
    auth_user: '0',
    status: 'ACTIVE',
    priority: 10,
    weight: 1,
    supported_models: ['gemini-2.5-flash'],
    profile_dir: '',
    user_agent: '',
    locale: 'en-US',
    timezone: 'UTC',
    last_keepalive_at: now,
    keepalive_status: 'IDLE',
    last_success_at: now,
    last_error_at: null,
    last_error: null,
    cooldown_until: null,
    consecutive_errors: 0,
    request_count: 0,
    created_at: now,
    updated_at: now,
  };

  db.createAccount(fileAccA);
  db.createAccount(fileAccB);

  db.saveUploadedFile({
    id: 'file_test_alpha',
    account_id: fileAccA.id,
    name: 'test_a.pdf',
    mime_type: 'application/pdf',
    size: 1024,
    created_at: now,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });

  db.saveUploadedFile({
    id: 'file_test_beta',
    account_id: fileAccB.id,
    name: 'test_b.pdf',
    mime_type: 'application/pdf',
    size: 2048,
    created_at: now,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });

  const validRecordA = db.getUploadedFile('file_test_alpha');
  assert(validRecordA?.account_id === fileAccA.id, 'Uploaded file record retrieves correct account affinity');

  // Verify combining files from multiple accounts throws FILE_ACCOUNT_MISMATCH
  const multiFileApiKey: ApiKey = {
    id: `key_file_test_${Date.now()}`,
    name: 'File Affinity Key',
    key_prefix: 'sk-gmgw-file1234',
    key_hash: 'hash_file_1',
    allowed_models: ['gemini-2.5-flash'],
    rpm_limit: 60,
    concurrent_limit: 10,
    daily_request_limit: 1000,
    created_at: now,
    expires_at: null,
    enabled: true,
    last_used_at: null,
  };

  try {
    await gatewayService.handleChatCompletion(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Analyze these files' }],
        uploaded_files: [
          { id: 'file_test_alpha', name: 'test_a.pdf' },
          { id: 'file_test_beta', name: 'test_b.pdf' },
        ],
      },
      multiFileApiKey,
      'req_file_mismatch_1'
    );
    assert(false, 'Combining files from multiple accounts should throw error');
  } catch (err: any) {
    assert(
      err.message.includes('FILE_ACCOUNT_MISMATCH'),
      'Mixed account files rejected with FILE_ACCOUNT_MISMATCH',
      err.message
    );
  }

  // Clean up test accounts
  db.deleteAccount(fileAccA.id);
  db.deleteAccount(fileAccB.id);

  // Test 4: Session cache invalidation
  console.log('\n--- Test 4: Session Cache Invalidation ---');
  const webProvider = new GeminiWebProvider();
  (webProvider as any).sessionCache.set('acc_sess_1', {
    snlm0e: 'test_token',
    pushId: 'test_push',
    buildLabel: 'bl',
    sessionId: 'sid',
    language: 'en',
    generationId: 'gen',
    cookieHeader: 'c=1',
    discoveredModels: [],
    fetchedAt: Date.now(),
  });

  assert((webProvider as any).sessionCache.has('acc_sess_1'), 'Session cache populated for account');
  const invalidated = webProvider.invalidateSession('acc_sess_1');
  assert(invalidated === true, 'invalidateSession returned true for existing session');
  assert(!(webProvider as any).sessionCache.has('acc_sess_1'), 'Session cache successfully removed');

  // Test 5: Native multi-turn prompt building (no duplicate history replay)
  console.log('\n--- Test 5: Native Multi-Turn Context (No Duplicate Replay) ---');
  const testMessages = [
    { role: 'system' as const, content: 'You are a helpful assistant.' },
    { role: 'user' as const, content: 'Hello, my name is Alex.' },
    { role: 'assistant' as const, content: 'Nice to meet you, Alex!' },
    { role: 'user' as const, content: 'What is my name?' },
  ];

  // With native conversation (hasNativeConversation = true)
  const nativeResult = webProvider.buildPromptAndAttachments(testMessages, true);
  assert(
    nativeResult.prompt.includes('What is my name?'),
    'Native turn contains latest user turn'
  );
  assert(
    !nativeResult.prompt.includes('Hello, my name is Alex.'),
    'Native turn does NOT replay previous user turn'
  );
  assert(
    !nativeResult.prompt.includes('Nice to meet you, Alex!'),
    'Native turn does NOT replay previous assistant turn'
  );
  assert(
    nativeResult.prompt.includes('[System Instructions]'),
    'Native turn includes system instruction'
  );

  // Without native conversation (hasNativeConversation = false)
  const nonNativeResult = webProvider.buildPromptAndAttachments(testMessages, false);
  assert(
    nonNativeResult.prompt.includes('User: Hello, my name is Alex.') &&
    nonNativeResult.prompt.includes('Assistant: Nice to meet you, Alex!') &&
    nonNativeResult.prompt.includes('User: What is my name?'),
    'Non-native turn replays full history for upstream context establishment'
  );

  // Test 6: Timeout & Client Abort do not penalize account
  console.log('\n--- Test 6: Timeout & Client Abort Error Classification ---');
  const abortAccount: GeminiAccount = {
    id: `acc_abort_test_${Date.now()}`,
    name: 'Abort Test Account',
    email_label: 'abort@example.com',
    encrypted_cookie: 'dummy:cookie:enc',
    auth_user: '0',
    status: 'ACTIVE',
    priority: 10,
    weight: 1,
    supported_models: ['gemini-2.5-flash'],
    profile_dir: '',
    user_agent: '',
    locale: 'en-US',
    timezone: 'UTC',
    last_keepalive_at: now,
    keepalive_status: 'IDLE',
    last_success_at: now,
    last_error_at: null,
    last_error: null,
    cooldown_until: null,
    consecutive_errors: 0,
    request_count: 0,
    created_at: now,
    updated_at: now,
  };
  db.createAccount(abortAccount);

  // Simulate client abort error
  quotaManager.recordError(abortAccount.id, new Error('CLIENT_ABORT: Request cancelled by client'));
  const updatedAcc1 = db.getAccountById(abortAccount.id);
  assert(updatedAcc1?.consecutive_errors === 0, 'Client abort error does NOT increment consecutive_errors');
  assert(updatedAcc1?.status === 'ACTIVE', 'Client abort error does NOT change account status');

  quotaManager.recordError(abortAccount.id, new Error('AbortError: The operation was aborted'));
  const updatedAcc2 = db.getAccountById(abortAccount.id);
  assert(updatedAcc2?.consecutive_errors === 0, 'AbortError does NOT increment consecutive_errors');

  // Test 7: Failover on recoverable errors vs non-recoverable
  console.log('\n--- Test 7: Error Classification & Failover Boundaries ---');
  // Record session expired
  quotaManager.recordError(abortAccount.id, new Error('SESSION_EXPIRED: Upstream cookie invalid'));
  const updatedAcc3 = db.getAccountById(abortAccount.id);
  assert(updatedAcc3?.status === 'SESSION_EXPIRED', 'SESSION_EXPIRED correctly marks account SESSION_EXPIRED');

  // Record quota exhausted
  quotaManager.recordError(abortAccount.id, new Error('QUOTA_EXHAUSTED: Upstream rate limit reached (HTTP 429)'));
  const updatedAcc4 = db.getAccountById(abortAccount.id);
  assert(updatedAcc4?.status === 'QUOTA_EXHAUSTED', 'QUOTA_EXHAUSTED sets status with cooldown');
  assert(Boolean(updatedAcc4?.cooldown_until), 'QUOTA_EXHAUSTED assigns cooldown timestamp');

  db.deleteAccount(abortAccount.id);

  // Test 8: SQLite concurrent atomic update consistency
  console.log('\n--- Test 8: SQLite Concurrent Atomic Counters ---');
  const counterAccount: GeminiAccount = {
    id: `acc_counter_test_${Date.now()}`,
    name: 'Counter Test Account',
    email_label: 'counter@example.com',
    encrypted_cookie: 'dummy:cookie:enc',
    auth_user: '0',
    status: 'ACTIVE',
    priority: 10,
    weight: 1,
    supported_models: ['gemini-2.5-flash'],
    profile_dir: '',
    user_agent: '',
    locale: 'en-US',
    timezone: 'UTC',
    last_keepalive_at: now,
    keepalive_status: 'IDLE',
    last_success_at: null,
    last_error_at: null,
    last_error: null,
    cooldown_until: null,
    consecutive_errors: 0,
    request_count: 0,
    created_at: now,
    updated_at: now,
  };
  db.createAccount(counterAccount);

  // Run 50 concurrent success updates in parallel
  const concurrency = 50;
  await Promise.all(
    Array.from({ length: concurrency }).map(() => {
      return Promise.resolve().then(() => {
        db.recordAccountSuccess(counterAccount.id);
      });
    })
  );

  const finalCounterAcc = db.getAccountById(counterAccount.id);
  assert(
    finalCounterAcc?.request_count === concurrency,
    `Atomic counter increment exactly matches ${concurrency} concurrent requests (got ${finalCounterAcc?.request_count})`
  );

  db.deleteAccount(counterAccount.id);

  console.log(`\n========================================`);
  console.log(`🏁 Regression Results: ${regressionPassed} Passed, ${regressionFailed} Failed`);
  console.log(`========================================\n`);

  if (regressionFailed > 0) {
    throw new Error(`Regression test suite failed: ${regressionFailed} errors`);
  }
}
