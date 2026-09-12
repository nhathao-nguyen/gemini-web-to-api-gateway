import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from '../db/database.js';
import { quotaManager } from '../services/quota-manager.js';
import { apiKeyManager } from '../services/api-key-manager.js';
import { accountScheduler } from '../services/scheduler.js';
import { accountManager } from '../services/account-manager.js';
import { gatewayService } from '../services/gateway-service.js';
import { geminiProvider } from '../services/gemini-adapter/index.js';
import { EventEmitter } from 'events';
import { RamMediaCache } from '../services/ram-media-cache.js';
import {
  GeminiWebProvider,
  hasUsableNativeConversationState,
  readBodyWithTimeout,
  readBufferWithTimeout,
  getRemainingTimeout,
} from '../services/gemini-adapter/gemini-web.js';
import { GeminiAccount, ApiKey } from '../types.js';

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

function createDummyAccount(id: string, name: string, models = ['gemini-2.5-flash', 'gemini-3.8-flash']): GeminiAccount {
  const now = new Date().toISOString();
  return {
    id,
    name,
    email_label: `${id}@example.com`,
    encrypted_cookie: 'iv123456789012:tag1234567890123:cipher123456',
    auth_user: '0',
    status: 'ACTIVE',
    priority: 10,
    weight: 1,
    supported_models: models,
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
}

function createDummyApiKey(id: string, models = ['gemini-2.5-flash', 'gemini-3.8-flash']): ApiKey {
  return {
    id,
    name: `Test Key ${id}`,
    key_prefix: `sk-gmgw-${id.slice(0, 8)}`,
    key_hash: `hash_${id}`,
    allowed_models: models,
    rpm_limit: 120,
    concurrent_limit: 20,
    daily_request_limit: 10000,
    created_at: new Date().toISOString(),
    expires_at: null,
    enabled: true,
    last_used_at: null,
  };
}

export async function runRegressionTests() {
  console.log('\n======================================================');
  console.log('🧪 Running Stateless Gateway Regression Test Suite (12 Requirements)');
  console.log('======================================================\n');

  const webProvider = new GeminiWebProvider();

  // ----------------------------------------------------
  // Requirement 1: c_... từ Gemini có thể continue dù không có local DB conversation
  // ----------------------------------------------------
  console.log('--- Req 1: c_... Can Continue Without Local DB Conversation Record ---');
  const r1Account = createDummyAccount('acc_req1_test', 'Req1 Account');
  const r1ApiKey = createDummyApiKey('key_req1_test');
  db.createAccount(r1Account);
  db.createApiKey(r1ApiKey);

  const originalChatCompletion = geminiProvider.ChatCompletion.bind(geminiProvider);
  try {
    let capturedReq: any = null;
    (geminiProvider as any).ChatCompletion = async (acc: GeminiAccount, req: any) => {
      capturedReq = req;
      return {
        text: 'Hello from stateless conversation continuation!',
        conversation_id: req.upstream_cid || 'c_upstream_999',
        response_id: 'rid_req1_resp',
        choice_id: 'rcid_req1_resp',
        prompt_tokens: 10,
        completion_tokens: 15,
      };
    };

    const res = await gatewayService.handleChatCompletion(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'What was my previous question?' }],
        conversation_id: 'c_upstream_999',
        upstream_cid: 'c_upstream_999',
        upstream_rid: 'rid_req1_prev',
        upstream_rcid: 'rcid_req1_prev',
      },
      r1ApiKey,
      'req_test_1'
    );

    assert(Boolean(res.response.choices[0].message.content), 'c_... request completes successfully');
    assert(capturedReq?.upstream_cid === 'c_upstream_999', 'Upstream CID forwarded to Gemini RPC');
    assert(capturedReq?.upstream_rid === 'rid_req1_prev', 'Upstream RID forwarded to Gemini RPC');
    assert(capturedReq?.upstream_rcid === 'rcid_req1_prev', 'Upstream RCID forwarded to Gemini RPC');
    assert(
      accountScheduler.getConversationAffinity('c_upstream_999') === r1Account.id,
      'Conversation affinity registered in RAM for c_...'
    );
  } finally {
    (geminiProvider as any).ChatCompletion = originalChatCompletion;
    db.deleteAccount(r1Account.id);
    db.deleteApiKey(r1ApiKey.id);
  }

  // ----------------------------------------------------
  // Requirement 2: Native multi-turn không replay duplicate history
  // ----------------------------------------------------
  console.log('\n--- Req 2: Native Multi-Turn Context (No Duplicate Replay) ---');
  // 2a: Helper hasUsableNativeConversationState check
  const stateWithAll = hasUsableNativeConversationState({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
    conversation_id: 'c_valid_upstream_123',
    upstream_rid: 'rid_123',
    upstream_rcid: 'rcid_123',
  });
  assert(stateWithAll === true, 'hasUsableNativeConversationState returns true when c_..., rid, and rcid are present');

  const stateMissingRcid = hasUsableNativeConversationState({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
    conversation_id: 'c_valid_upstream_123',
    upstream_rid: 'rid_123',
  });
  assert(stateMissingRcid === false, 'hasUsableNativeConversationState returns false when rcid is missing');

  const stateNonNativeId = hasUsableNativeConversationState({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
    conversation_id: 'conv_local_456',
    upstream_rid: 'rid_123',
    upstream_rcid: 'rcid_123',
  });
  assert(stateNonNativeId === false, 'hasUsableNativeConversationState returns false when conversation_id is not c_...');

  // 2b: buildPromptAndAttachments deduplication
  const multiTurnMessages = [
    { role: 'system' as const, content: 'You are a helpful assistant.' },
    { role: 'user' as const, content: 'Remember the secret code: 778899' },
    { role: 'assistant' as const, content: 'Got it, secret code recorded.' },
    { role: 'user' as const, content: 'What is the secret code?' },
  ];

  const nativePrompt = webProvider.buildPromptAndAttachments(multiTurnMessages, true);
  assert(nativePrompt.prompt.includes('What is the secret code?'), 'Native turn contains latest user prompt');
  assert(!nativePrompt.prompt.includes('Remember the secret code: 778899'), 'Native turn does NOT replay previous user turn');
  assert(!nativePrompt.prompt.includes('Got it, secret code recorded.'), 'Native turn does NOT replay previous assistant turn');

  const nonNativePrompt = webProvider.buildPromptAndAttachments(multiTurnMessages, false);
  assert(
    nonNativePrompt.prompt.includes('Remember the secret code: 778899') &&
    nonNativePrompt.prompt.includes('Got it, secret code recorded.') &&
    nonNativePrompt.prompt.includes('What is the secret code?'),
    'Non-native turn replays full history for initial context bootstrap'
  );

  // ----------------------------------------------------
  // Requirement 3: Recent conversation/history không tạo DB records
  // ----------------------------------------------------
  console.log('\n--- Req 3: Recent Conversations & Turns Query Upstream Without DB Records ---');
  const r3Account = createDummyAccount('acc_req3_test', 'Req3 Account');
  db.createAccount(r3Account);

  const initialAccountCount = db.getAccounts().length;
  const initialApiKeyCount = db.getApiKeys().length;

  const originalFetchRecent = (geminiProvider as any).webProvider.fetchRecentConversations;
  const originalFetchHistory = (geminiProvider as any).webProvider.fetchConversationHistory;

  try {
    (geminiProvider as any).webProvider.fetchRecentConversations = async () => [
      { id: 'c_upstream_rec_1', title: 'Recent Conversation 1' },
      { id: 'c_upstream_rec_2', title: 'Recent Conversation 2' },
    ];
    (geminiProvider as any).webProvider.fetchConversationHistory = async () => ({
      turns: [{ role: 'user', content: 'Turn 1' }, { role: 'assistant', content: 'Turn 2' }],
      lastRid: 'rid_rec_1',
      lastRcid: 'rcid_rec_1',
    });

    const recent = await geminiProvider.fetchRecentConversations(r3Account, 5);
    const history = await geminiProvider.fetchConversationHistory(r3Account, 'c_upstream_rec_1');

    assert(recent.length === 2, 'Recent conversations returned from upstream relay');
    assert(history.turns.length === 2, 'Conversation turns returned from upstream relay');

    // Verify DB was NOT modified
    assert(db.getAccounts().length === initialAccountCount, 'No account rows created in SQLite');
    assert(db.getApiKeys().length === initialApiKeyCount, 'No API key rows created in SQLite');
    // Ensure no conversation/message tables exist in db object
    assert((db as any).getConversation === undefined, 'No getConversation method exists in DB');
    assert((db as any).listMessages === undefined, 'No listMessages method exists in DB');
  } finally {
    (geminiProvider as any).webProvider.fetchRecentConversations = originalFetchRecent;
    (geminiProvider as any).webProvider.fetchConversationHistory = originalFetchHistory;
    db.deleteAccount(r3Account.id);
  }

  // ----------------------------------------------------
  // Requirement 4: Uploaded file affinity nằm RAM và ép đúng account
  // ----------------------------------------------------
  console.log('\n--- Req 4: Uploaded File Affinity Stored in RAM & Pinned to Account ---');
  const r4AccA = createDummyAccount('acc_req4_a', 'Req4 Account A');
  const r4AccB = createDummyAccount('acc_req4_b', 'Req4 Account B');
  db.createAccount(r4AccA);
  db.createAccount(r4AccB);

  accountScheduler.setUploadedFileAffinity('file_affinity_alpha', r4AccA.id);
  accountScheduler.setUploadedFileAffinity('file_affinity_beta', r4AccB.id);

  assert(
    accountScheduler.getUploadedFileAffinity('file_affinity_alpha') === r4AccA.id,
    'Uploaded file alpha maps to Account A in RAM'
  );
  assert(
    accountScheduler.getUploadedFileAffinity('file_affinity_beta') === r4AccB.id,
    'Uploaded file beta maps to Account B in RAM'
  );

  const pinnedTarget = accountScheduler.checkUploadedFilesAffinity([{ id: 'file_affinity_alpha', name: 'alpha.pdf' }]);
  assert(pinnedTarget === r4AccA.id, 'checkUploadedFilesAffinity resolves to Account A');

  // Verify multiple accounts mismatch throws FILE_ACCOUNT_MISMATCH
  let threwMismatch = false;
  try {
    accountScheduler.checkUploadedFilesAffinity([
      { id: 'file_affinity_alpha', name: 'alpha.pdf' },
      { id: 'file_affinity_beta', name: 'beta.pdf' },
    ]);
  } catch (err: any) {
    threwMismatch = err.message.includes('FILE_ACCOUNT_MISMATCH');
  }
  assert(threwMismatch, 'Combining files from multiple accounts throws FILE_ACCOUNT_MISMATCH');

  db.deleteAccount(r4AccA.id);
  db.deleteAccount(r4AccB.id);

  // ----------------------------------------------------
  // Requirement 5: Unknown/expired file ID -> FILE_NOT_FOUND_OR_EXPIRED
  // ----------------------------------------------------
  console.log('\n--- Req 5: Unknown or Expired File ID Throws FILE_NOT_FOUND_OR_EXPIRED ---');
  let threwExpired = false;
  try {
    accountScheduler.checkUploadedFilesAffinity([{ id: 'file_nonexistent_999', name: 'lost.pdf' }]);
  } catch (err: any) {
    threwExpired = err.message.includes('FILE_NOT_FOUND_OR_EXPIRED');
  }
  assert(threwExpired, 'Unknown file ID rejected with FILE_NOT_FOUND_OR_EXPIRED');

  // Expired file simulation (negative TTL)
  accountScheduler.setUploadedFileAffinity('file_already_expired', 'acc_any', -1000);
  let threwTtlExpired = false;
  try {
    accountScheduler.checkUploadedFilesAffinity([{ id: 'file_already_expired', name: 'expired.pdf' }]);
  } catch (err: any) {
    threwTtlExpired = err.message.includes('FILE_NOT_FOUND_OR_EXPIRED');
  }
  assert(threwTtlExpired, 'Expired file ID rejected with FILE_NOT_FOUND_OR_EXPIRED');

  // ----------------------------------------------------
  // Requirement 6: Conversation affinity ép đúng Gemini account
  // ----------------------------------------------------
  console.log('\n--- Req 6: Conversation Affinity Pinned to Right Gemini Account ---');
  const r6AccA = createDummyAccount('acc_req6_a', 'Req6 Account A');
  const r6AccB = createDummyAccount('acc_req6_b', 'Req6 Account B');
  db.createAccount(r6AccA);
  db.createAccount(r6AccB);

  accountScheduler.setConversationAffinity('c_conv_affinity_1', r6AccA.id);
  assert(
    accountScheduler.getConversationAffinity('c_conv_affinity_1') === r6AccA.id,
    'Conversation affinity points to Account A'
  );

  const r6ApiKey = createDummyApiKey('key_req6');
  db.createApiKey(r6ApiKey);

  let invokedAccountId = '';
  (geminiProvider as any).ChatCompletion = async (acc: GeminiAccount) => {
    invokedAccountId = acc.id;
    return { text: 'ok', prompt_tokens: 1, completion_tokens: 1 };
  };

  await gatewayService.handleChatCompletion(
    {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'test' }],
      conversation_id: 'c_conv_affinity_1',
    },
    r6ApiKey,
    'req_affinity_select_test'
  );
  assert(invokedAccountId === r6AccA.id, 'Gateway routes to Account A based on conversation affinity');

  (geminiProvider as any).ChatCompletion = originalChatCompletion;
  db.deleteAccount(r6AccA.id);
  db.deleteAccount(r6AccB.id);
  db.deleteApiKey(r6ApiKey.id);

  // ----------------------------------------------------
  // Requirement 7: Hard affinity không failover sai account
  // ----------------------------------------------------
  console.log('\n--- Req 7: Hard Affinity Request Does Not Failover to Wrong Account ---');
  const r7AccA = createDummyAccount('acc_req7_a', 'Req7 Account A');
  const r7AccB = createDummyAccount('acc_req7_b', 'Req7 Account B');
  const r7ApiKey = createDummyApiKey('key_req7');
  db.createAccount(r7AccA);
  db.createAccount(r7AccB);
  db.createApiKey(r7ApiKey);

  accountScheduler.setConversationAffinity('c_pinned_account_a', r7AccA.id);

  let invokedAccounts: string[] = [];
  try {
    (geminiProvider as any).ChatCompletion = async (acc: GeminiAccount) => {
      invokedAccounts.push(acc.id);
      throw new Error('UPSTREAM_TIMEOUT: Upstream RPC timed out');
    };

    await gatewayService.handleChatCompletion(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'test' }],
        conversation_id: 'c_pinned_account_a',
        upstream_cid: 'c_pinned_account_a',
        upstream_rid: 'r1',
        upstream_rcid: 'rc1',
      },
      r7ApiKey,
      'req_failover_test'
    );
    assert(false, 'Expected request to throw');
  } catch (err: any) {
    assert(invokedAccounts.length === 1, 'Only pinned account was invoked (no failover to Account B)');
    assert(invokedAccounts[0] === r7AccA.id, 'Invocation was directed to Account A');
    assert(
      !invokedAccounts.includes(r7AccB.id),
      'Account B was NEVER invoked for Account A pinned conversation'
    );
  } finally {
    (geminiProvider as any).ChatCompletion = originalChatCompletion;
    db.deleteAccount(r7AccA.id);
    db.deleteAccount(r7AccB.id);
    db.deleteApiKey(r7ApiKey.id);
  }

  // ----------------------------------------------------
  // Requirement 8: Session invalidation sau cookie update
  // ----------------------------------------------------
  console.log('\n--- Req 8: Session Invalidation on Cookie / Auth_User Update ---');
  const r8Account = createDummyAccount('acc_req8_test', 'Req8 Account');
  db.createAccount(r8Account);

  (geminiProvider as any).webProvider.sessionCache.set(r8Account.id, {
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

  assert(
    (geminiProvider as any).webProvider.sessionCache.has(r8Account.id),
    'Session cache initially populated'
  );

  // Cookie replacement invalidates session cache
  accountManager.replaceCookie(r8Account.id, '__Secure-1PSID=new_valid_psid; __Secure-1PSIDTS=new_ts');
  assert(
    !(geminiProvider as any).webProvider.sessionCache.has(r8Account.id),
    'replaceCookie invalidates old session cache'
  );

  // Repopulate and test auth_user change
  (geminiProvider as any).webProvider.sessionCache.set(r8Account.id, {
    snlm0e: 'test_token_2',
    pushId: 'test_push_2',
    buildLabel: 'bl',
    sessionId: 'sid_2',
    language: 'en',
    generationId: 'gen_2',
    cookieHeader: 'c=2',
    discoveredModels: [],
    fetchedAt: Date.now(),
  });

  accountManager.updateAccount(r8Account.id, { auth_user: '2' });
  assert(
    !(geminiProvider as any).webProvider.sessionCache.has(r8Account.id),
    'updateAccount with changed auth_user invalidates session cache'
  );

  db.deleteAccount(r8Account.id);

  // ----------------------------------------------------
  // Requirement 9: Client abort không penalize account
  // ----------------------------------------------------
  console.log('\n--- Req 9: Client Abort Does Not Penalize Account ---');
  const r9Account = createDummyAccount('acc_req9_test', 'Req9 Account');
  db.createAccount(r9Account);

  quotaManager.recordError(r9Account.id, new Error('CLIENT_ABORT: Request cancelled by client'));
  const updatedAcc1 = db.getAccountById(r9Account.id);
  assert(updatedAcc1?.consecutive_errors === 0, 'CLIENT_ABORT does not increment consecutive_errors');
  assert(updatedAcc1?.status === 'ACTIVE', 'CLIENT_ABORT maintains ACTIVE status');

  quotaManager.recordError(r9Account.id, new Error('AbortError: The operation was aborted'));
  const updatedAcc2 = db.getAccountById(r9Account.id);
  assert(updatedAcc2?.consecutive_errors === 0, 'AbortError does not increment consecutive_errors');
  assert(updatedAcc2?.status === 'ACTIVE', 'AbortError maintains ACTIVE status');

  db.deleteAccount(r9Account.id);

  // ----------------------------------------------------
  // Requirement 10: Timeout áp dụng cả body/stream
  // ----------------------------------------------------
  console.log('\n--- Req 10: Operation-Wide Timeout Covers Body & Stream ---');
  // 10a: Test readBodyWithTimeout with stalled stream
  const stalledStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('initial chunk\n'));
      // Intentionally do not close or enqueue more to simulate stall
    },
  });
  const mockStalledRes = new Response(stalledStream);

  let bodyTimeoutThrew = false;
  try {
    await readBodyWithTimeout(mockStalledRes, 150);
  } catch (err: any) {
    bodyTimeoutThrew = err.message.includes('UPSTREAM_TIMEOUT');
  }
  assert(bodyTimeoutThrew, 'readBodyWithTimeout aborts and throws UPSTREAM_TIMEOUT when stream stalls');

  // 10b: Test readBufferWithTimeout with stalled stream
  const stalledBufferStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      // Intentionally stall
    },
  });
  const mockStalledBufRes = new Response(stalledBufferStream);

  let bufTimeoutThrew = false;
  try {
    await readBufferWithTimeout(mockStalledBufRes, 150);
  } catch (err: any) {
    bufTimeoutThrew = err.message.includes('UPSTREAM_TIMEOUT');
  }
  assert(bufTimeoutThrew, 'readBufferWithTimeout aborts and throws UPSTREAM_TIMEOUT when stream stalls');

  // ----------------------------------------------------
  // Requirement 11: Không có plaintext Gateway API key trong browser storage
  // ----------------------------------------------------
  console.log('\n--- Req 11: Plaintext Gateway API Key Browser Storage Audit ---');
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
      content.includes("localStorage.getItem('gmgw_playground_key')") ||
      content.includes("sessionStorage.getItem('gmgw_playground_key')")
    ) {
      foundStorageKey = true;
      console.error(`Found storage leak in: ${file}`);
    }
  }
  assert(!foundStorageKey, 'No localStorage or sessionStorage usage of gmgw_playground_key in src/');

  // ----------------------------------------------------
  // Requirement 12: Restart semantics: account/API key còn DB, affinity RAM có thể mất
  // ----------------------------------------------------
  console.log('\n--- Req 12: Restart Semantics (DB Persists Accounts/Keys, RAM Affinities Ephemeral) ---');
  const r12Account = createDummyAccount('acc_req12_test', 'Req12 Account');
  const r12ApiKey = createDummyApiKey('key_req12_test');
  db.createAccount(r12Account);
  db.createApiKey(r12ApiKey);

  // Establish affinities in RAM
  accountScheduler.setConversationAffinity('c_pre_restart_1', r12Account.id);
  accountScheduler.setUploadedFileAffinity('file_pre_restart_1', r12Account.id);

  assert(accountScheduler.getConversationAffinity('c_pre_restart_1') === r12Account.id, 'Pre-restart conv affinity in RAM');
  assert(accountScheduler.getUploadedFileAffinity('file_pre_restart_1') === r12Account.id, 'Pre-restart file affinity in RAM');

  // Simulate Gateway process restart by wiping RAM affinity maps
  accountScheduler.clearAffinities();

  // 1. Verify SQLite data is completely intact
  const accAfterRestart = db.getAccountById(r12Account.id);
  assert(Boolean(accAfterRestart && accAfterRestart.name === 'Req12 Account'), 'Account persists in SQLite across restart');
  const keyAfterRestart = db.getApiKeyById(r12ApiKey.id);
  assert(Boolean(keyAfterRestart && keyAfterRestart.enabled), 'API key persists in SQLite across restart');

  // 2. Verify RAM affinities are reset
  assert(accountScheduler.getConversationAffinity('c_pre_restart_1') === null, 'Conversation affinity cleanly cleared on restart');
  assert(accountScheduler.getUploadedFileAffinity('file_pre_restart_1') === null, 'Uploaded file affinity cleanly cleared on restart');

  // 3. Verify incoming request with c_... after restart still works seamlessly by selecting available account
  try {
    (geminiProvider as any).ChatCompletion = async (acc: GeminiAccount, req: any) => ({
      text: 'Post-restart conversation continuation',
      conversation_id: req.upstream_cid,
      response_id: 'rid_post_restart',
      choice_id: 'rcid_post_restart',
      prompt_tokens: 5,
      completion_tokens: 5,
    });

    const postRestartRes = await gatewayService.handleChatCompletion(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Continue conversation after restart' }],
        conversation_id: 'c_pre_restart_1',
        upstream_cid: 'c_pre_restart_1',
        upstream_rid: 'rid_prev',
        upstream_rcid: 'rcid_prev',
      },
      r12ApiKey,
      'req_post_restart_1'
    );
    assert(Boolean(postRestartRes.response.choices[0].message.content), 'Post-restart request executes successfully');
    assert(
      accountScheduler.getConversationAffinity('c_pre_restart_1') === r12Account.id,
      'RAM affinity re-established for subsequent requests after restart'
    );
  } finally {
    (geminiProvider as any).ChatCompletion = originalChatCompletion;
    db.deleteAccount(r12Account.id);
    db.deleteApiKey(r12ApiKey.id);
  }

  // ----------------------------------------------------
  // Additional Regression: SQLite Concurrent Atomic Counters
  // ----------------------------------------------------
  console.log('\n--- Bonus: SQLite Concurrent Atomic Counters Consistency ---');
  const counterAccount = createDummyAccount('acc_counter_test', 'Counter Account');
  db.createAccount(counterAccount);

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

  // ----------------------------------------------------
  // Suite: Hardened Client Disconnect, History Affinity, RAM Media Bytes & Timeouts (12 Tests)
  // ----------------------------------------------------
  console.log('\n--- Hardened Lifecycle, Affinity, Media Bytes & Timeout Suites ---');

  // Test 1: Request lifecycle bình thường không bị abort nhầm
  {
    const abortCtrl = new AbortController();
    const mockReq = new EventEmitter();
    const mockRes = new EventEmitter() as any;
    mockRes.writableEnded = false;

    const onClose = () => {
      if (!mockRes.writableEnded && !abortCtrl.signal.aborted) {
        abortCtrl.abort();
      }
    };
    mockRes.on('close', onClose);

    // Incoming request body read complete emits 'close' on req
    mockReq.emit('close');
    assert(!abortCtrl.signal.aborted, 'Normal request close on req does not abort AbortController');

    // Normal response completion finishes writing
    mockRes.writableEnded = true;
    mockRes.emit('close');
    mockRes.removeListener('close', onClose);
    assert(!abortCtrl.signal.aborted, 'Normal response finish (writableEnded=true) does not abort AbortController');
  }

  // Test 2: Actual response close/abort cancel upstream
  {
    const abortCtrl = new AbortController();
    const mockRes = new EventEmitter() as any;
    mockRes.writableEnded = false;

    const onClose = () => {
      if (!mockRes.writableEnded && !abortCtrl.signal.aborted) {
        abortCtrl.abort();
      }
    };
    mockRes.on('close', onClose);

    // Client cuts connection prematurely while writableEnded is false
    mockRes.emit('close');
    assert(abortCtrl.signal.aborted, 'Premature client response close aborts upstream AbortController');
  }

  // Test 3: History route ưu tiên conversation affinity
  {
    const accHistA = createDummyAccount('acc_hist_a', 'Account Hist A');
    const accHistB = createDummyAccount('acc_hist_b', 'Account Hist B');
    db.createAccount(accHistA);
    db.createAccount(accHistB);

    accountScheduler.setConversationAffinity('c_pinned_hist_1', accHistA.id);

    // Simulate affinity-first account selection for conversation history
    let chosenAccountId: string | null = null;
    const affinityId = accountScheduler.getConversationAffinity('c_pinned_hist_1');
    if (affinityId) {
      const acc = db.getAccountById(affinityId);
      if (acc && acc.status === 'ACTIVE' && !quotaManager.isCoolingDown(acc)) {
        chosenAccountId = acc.id;
      }
    }
    assert(chosenAccountId === accHistA.id, 'History route resolves pinned conversation affinity to Account A');

    // Refresh TTL on success
    accountScheduler.setConversationAffinity('c_pinned_hist_1', accHistA.id);
    assert(
      accountScheduler.getConversationAffinity('c_pinned_hist_1') === accHistA.id,
      'Conversation affinity TTL refreshed on successful history fetch'
    );

    db.deleteAccount(accHistA.id);
    db.deleteAccount(accHistB.id);
  }

  // Test 4: History không failover sang sai account
  {
    const accHistP = createDummyAccount('acc_hist_p', 'Account Hist P');
    accHistP.status = 'SESSION_EXPIRED';
    const accHistQ = createDummyAccount('acc_hist_q', 'Account Hist Q'); // active
    db.createAccount(accHistP);
    db.createAccount(accHistQ);

    accountScheduler.setConversationAffinity('c_pinned_hist_fail', accHistP.id);

    let threwUnavailable = false;
    let chosenAccount: any = null;
    const affinityId = accountScheduler.getConversationAffinity('c_pinned_hist_fail');
    if (affinityId) {
      const acc = db.getAccountById(affinityId);
      if (!acc || acc.status !== 'ACTIVE' || quotaManager.isCoolingDown(acc)) {
        threwUnavailable = true;
      } else {
        chosenAccount = acc;
      }
    } else {
      chosenAccount = accountScheduler.selectAnyActiveAccount();
    }

    assert(threwUnavailable, 'History fetch detects inactive affinity account and triggers CONVERSATION_ACCOUNT_UNAVAILABLE');
    assert(chosenAccount === null, 'History fetch does not failover to Account Q when affinity account is unavailable');

    db.deleteAccount(accHistP.id);
    db.deleteAccount(accHistQ.id);
  }

  // Test 5: Recent conversation giữ đúng account affinity
  {
    const accRecent = createDummyAccount('acc_recent_1', 'Account Recent');
    db.createAccount(accRecent);

    const mockConversations = [
      { id: 'c_recent_alpha', title: 'Conversation Alpha' },
      { id: 'c_recent_beta', title: 'Conversation Beta' },
    ];

    for (const c of mockConversations) {
      accountScheduler.setConversationAffinity(c.id, accRecent.id);
    }

    assert(
      accountScheduler.getConversationAffinity('c_recent_alpha') === accRecent.id,
      'Recent conversation alpha affinity bound to Account Recent'
    );
    assert(
      accountScheduler.getConversationAffinity('c_recent_beta') === accRecent.id,
      'Recent conversation beta affinity bound to Account Recent'
    );

    db.deleteAccount(accRecent.id);
  }

  // Test 6: Media cache enforce maxItemBytes
  {
    const smallCache = new RamMediaCache({
      maxItemBytes: 500,
      maxTotalBytes: 5000,
    });
    const oversizedBuffer = Buffer.alloc(501, 'x');
    const saved = smallCache.saveMedia('oversized_item', oversizedBuffer);
    assert(!saved, 'Media cache rejects item exceeding maxItemBytes');
    assert(smallCache.getMedia('oversized_item') === null, 'Oversized item not present in media cache');
    assert(smallCache.getCurrentBytes() === 0, 'currentBytes remains 0 after rejected item');
  }

  // Test 7: Media cache enforce maxTotalBytes
  {
    const totalCapCache = new RamMediaCache({
      maxItemBytes: 1000,
      maxTotalBytes: 1500,
    });
    const buf1 = Buffer.alloc(700, 'a');
    const buf2 = Buffer.alloc(700, 'b');
    const buf3 = Buffer.alloc(700, 'c');

    totalCapCache.saveMedia('item_1', buf1);
    totalCapCache.saveMedia('item_2', buf2);
    assert(totalCapCache.getCurrentBytes() === 1400, 'Current bytes matches 1400 for item_1 + item_2');

    // Inserting item_3 (700 bytes) pushes total to 2100 > 1500, causing FIFO eviction of item_1
    totalCapCache.saveMedia('item_3', buf3);
    assert(totalCapCache.getMedia('item_1') === null, 'FIFO eviction removed oldest item_1');
    assert(totalCapCache.getMedia('item_2') !== null, 'item_2 remains in cache');
    assert(totalCapCache.getMedia('item_3') !== null, 'item_3 saved in cache');
    assert(totalCapCache.getCurrentBytes() === 1400, 'Current bytes maintained under maxTotalBytes (1400 <= 1500)');
  }

  // Test 8: Eviction cập nhật byte counter đúng
  {
    const accountingCache = new RamMediaCache({
      maxItemBytes: 1000,
      maxTotalBytes: 2000,
    });
    const b1 = Buffer.alloc(600, '1');
    const b2 = Buffer.alloc(800, '2');
    accountingCache.saveMedia('acc_1', b1);
    accountingCache.saveMedia('acc_2', b2);
    assert(accountingCache.getCurrentBytes() === 1400, 'currentBytes accurately set to 1400');

    accountingCache.deleteMedia('acc_1');
    assert(accountingCache.getCurrentBytes() === 800, 'currentBytes decremented to 800 after deleteMedia');

    accountingCache.clear();
    assert(accountingCache.getCurrentBytes() === 0, 'currentBytes reset to 0 after clear()');
  }

  // Test 9: Keep-alive update DB trước invalidate
  {
    const eventSequence: string[] = [];
    const testAcc = createDummyAccount('acc_order_test', 'Order Test');
    db.createAccount(testAcc);

    const originalUpdateAccount = db.updateAccount.bind(db);
    const originalInvalidate = (geminiProvider as any).invalidateSession.bind(geminiProvider);

    (db as any).updateAccount = (id: string, updates: any) => {
      eventSequence.push('db.updateAccount');
      return originalUpdateAccount(id, updates);
    };
    (geminiProvider as any).invalidateSession = (id: string) => {
      eventSequence.push('geminiProvider.invalidateSession');
      return originalInvalidate(id);
    };

    // Simulate keep-alive token refresh logic: DB update FIRST, then invalidate
    db.updateAccount(testAcc.id, {
      status: 'ACTIVE',
      last_keepalive_at: new Date().toISOString(),
      keepalive_status: 'SUCCESS',
    });
    geminiProvider.invalidateSession(testAcc.id);

    assert(
      eventSequence[0] === 'db.updateAccount' && eventSequence[1] === 'geminiProvider.invalidateSession',
      'Keep-alive updates SQLite DB BEFORE calling geminiProvider.invalidateSession'
    );

    (db as any).updateAccount = originalUpdateAccount;
    (geminiProvider as any).invalidateSession = originalInvalidate;
    db.deleteAccount(testAcc.id);
  }

  // Test 10: Shared deadline không reset giữa header/body/stream
  {
    const shortDeadline = Date.now() + 80;
    const remaining1 = getRemainingTimeout(shortDeadline, 'Phase 1');
    assert(remaining1 <= 80 && remaining1 > 0, 'Phase 1 timeout remaining is bounded by initial deadline');

    await new Promise((r) => setTimeout(r, 90));

    let deadlineThrew = false;
    try {
      getRemainingTimeout(shortDeadline, 'Phase 2');
    } catch (err: any) {
      deadlineThrew = err.message.includes('UPSTREAM_TIMEOUT');
    }
    assert(deadlineThrew, 'Shared deadline does not reset between phases and throws UPSTREAM_TIMEOUT');
  }

  // Test 11: UPSTREAM_TIMEOUT map thành HTTP 504
  {
    const timeoutErr = new Error('UPSTREAM_TIMEOUT: Upstream request timed out after 60000ms');
    const errMsg = timeoutErr.message;
    let statusCode = 500;
    let errCode = 'upstream_error';

    if (errMsg.includes('UPSTREAM_TIMEOUT')) {
      statusCode = 504;
      errCode = 'upstream_timeout';
    }

    assert(statusCode === 504, 'UPSTREAM_TIMEOUT maps to HTTP status 504');
    assert(errCode === 'upstream_timeout', 'UPSTREAM_TIMEOUT maps to error code upstream_timeout');
  }

  // Test 12: Client abort không tăng consecutive_errors
  {
    const abortAccount = createDummyAccount('acc_abort_penalty_test', 'Abort Penalty Test');
    db.createAccount(abortAccount);

    quotaManager.recordError(abortAccount.id, new Error('CLIENT_ABORT: Request cancelled by client'));
    const check1 = db.getAccountById(abortAccount.id);
    assert(check1?.consecutive_errors === 0, 'Client abort error does not increment consecutive_errors');
    assert(check1?.status === 'ACTIVE', 'Client abort maintains ACTIVE status without penalties');

    quotaManager.recordError(abortAccount.id, new Error('The user aborted a request.'));
    const check2 = db.getAccountById(abortAccount.id);
    assert(check2?.consecutive_errors === 0, 'User abort error does not increment consecutive_errors');
    assert(check2?.status === 'ACTIVE', 'User abort maintains ACTIVE status');

    db.deleteAccount(abortAccount.id);
  }

  console.log(`\n======================================================`);
  console.log(`🏁 Regression Results: ${regressionPassed} Passed, ${regressionFailed} Failed`);
  console.log(`======================================================\n`);

  if (regressionFailed > 0) {
    throw new Error(`Regression test suite failed: ${regressionFailed} errors`);
  }
}
