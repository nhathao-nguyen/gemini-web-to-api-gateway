import { encryptCookie, decryptCookie, hashApiKey, generateApiKey } from '../utils/crypto.js';
import { validateGeminiCookie, normalizeCookieString } from '../utils/cookie.js';
import { redactString, redactObject } from '../utils/redact.js';
import { OpenAIAdapter } from '../services/openai-adapter.js';
import { RateLimiter } from '../services/rate-limiter.js';
import { AccountScheduler, accountScheduler } from '../services/scheduler.js';
import { QuotaManager } from '../services/quota-manager.js';
import { ApiKeyManager } from '../services/api-key-manager.js';
import { GatewayService } from '../services/gateway-service.js';
import { geminiProvider } from '../services/gemini-adapter/index.js';
import { GeminiAccount, ApiKey } from '../types.js';

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, testName: string, detail?: any) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    testsPassed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}`, detail || '');
    testsFailed++;
  }
}

async function runAllTests() {
  console.log('\n🧪 Running Gemini Web-to-API Gateway Test Suite...\n');

  // 1. Encryption & Decryption Roundtrip
  console.log('--- Test Suite 1: AES-256-GCM Security & Key Hashing ---');
  const masterKey = '01234567890123456789012345678901';
  const rawCookie = '__Secure-1PSID=test_psid_value_123; __Secure-1PSIDTS=ts_456';
  const encrypted = encryptCookie(rawCookie, masterKey);
  const decrypted = decryptCookie(encrypted, masterKey);

  assert(encrypted.startsWith('') && encrypted.split(':').length === 3, 'Cookie is encrypted in iv:authTag:cipher format');
  assert(!encrypted.includes(rawCookie), 'Raw cookie is completely masked in encrypted text');
  assert(decrypted === rawCookie, 'Decryption matches original plain cookie exactly');

  const { apiKey, prefix, hash } = generateApiKey();
  assert(apiKey.startsWith('sk-gmgw-'), 'API key generated with prefix sk-gmgw-');
  assert(prefix === apiKey.slice(0, 16), 'API key prefix matches first 16 chars');
  assert(hashApiKey(apiKey) === hash, 'SHA-256 hash deterministic match');

  // Cookie Validation & Normalization
  const validCheck = validateGeminiCookie('__Secure-1PSID=val123; __Secure-1PSIDTS=ts456');
  assert(validCheck.valid, 'Cookie with __Secure-1PSID passes validation');
  assert(validCheck.normalized.includes('__Secure-1PSID='), 'Cookie normalized properly');

  const emptyCheck = validateGeminiCookie('');
  assert(!emptyCheck.valid && emptyCheck.missing.length > 0, 'Empty cookie fails validation');

  const malformedCheck = validateGeminiCookie('invalid_no_equal_sign');
  assert(!malformedCheck.valid && malformedCheck.missing.length > 0, 'Malformed cookie fails validation');

  const warnCheck = validateGeminiCookie('random_cookie=abc');
  assert(warnCheck.valid && warnCheck.warnings.length > 0, 'Cookie without __Secure-1PSID warns without blocking');

  const jsonCookie = JSON.stringify([
    { name: '__Secure-1PSID', value: 'json_psid_val' },
    { name: '__Secure-1PSIDTS', value: 'json_psidts_val' },
  ]);
  const normalizedFromJson = normalizeCookieString(jsonCookie);
  assert(normalizedFromJson.includes('__Secure-1PSID=json_psid_val'), 'Normalized JSON cookie export correctly');

  // 2. Secret Redaction
  console.log('\n--- Test Suite 2: Secret & PII Redaction ---');
  const leakStr = `Error with __Secure-1PSID=secret_123 and Bearer sk-gmgw-abcdef123456789012345678`;
  const sanitized = redactString(leakStr);
  assert(!sanitized.includes('secret_123'), 'Redacted Google session cookie string');
  assert(!sanitized.includes('sk-gmgw-abcdef123456789012345678'), 'Redacted Bearer API key');

  const leakObj = {
    cookie: 'raw_cookie_leak',
    encrypted_cookie: 'encrypted_val',
    apiKey: 'sk-gmgw-raw_val',
    name: 'Normal Name',
  };
  const sanitizedObj = redactObject(leakObj);
  assert(sanitizedObj.cookie === '[REDACTED]', 'Redacted sensitive object field');
  assert(sanitizedObj.name === 'Normal Name', 'Preserved non-sensitive field');

  // 3. Rate Limiting
  console.log('\n--- Test Suite 3: Sliding-Window Rate Limiter ---');
  const limiter = new RateLimiter();
  const testApiKey: ApiKey = {
    id: 'test_key_01',
    name: 'Test Key',
    key_prefix: 'sk-gmgw-test',
    key_hash: 'hash',
    enabled: true,
    allowed_models: ['*'],
    rpm_limit: 3,
    concurrent_limit: 2,
    daily_request_limit: 100,
    expires_at: null,
    created_at: new Date().toISOString(),
    last_used_at: null,
  };

  assert((await limiter.checkAndAcquire(testApiKey)).allowed, '1st request permitted');
  assert((await limiter.checkAndAcquire(testApiKey)).allowed, '2nd request permitted');
  // Concurrency limit is 2
  const concurExceeded = await limiter.checkAndAcquire(testApiKey);
  assert(!concurExceeded.allowed && concurExceeded.reason?.includes('Concurrent'), 'Concurrent request rejected at cap');

  await limiter.release(testApiKey.id);
  assert((await limiter.checkAndAcquire(testApiKey)).allowed, '3rd request permitted after concurrency release');

  // Release concurrency so concurrent check doesn't shadow RPM check
  await limiter.release(testApiKey.id);

  // 4th request in same minute exceeds RPM limit (3)
  const rpmExceeded = await limiter.checkAndAcquire(testApiKey);
  assert(!rpmExceeded.allowed && rpmExceeded.reason?.includes('Rate limit'), 'RPM limit enforced correctly on 4th request');

  // 4. Account Scheduler Scoring
  console.log('\n--- Test Suite 4: Account Scheduler Scoring & Selection ---');
  const scheduler = new AccountScheduler();
  const accountA: GeminiAccount = {
    id: 'acc_a',
    name: 'High Priority Account',
    email_label: 'a@example.com',
    encrypted_cookie: 'enc',
    auth_user: '0',
    status: 'ACTIVE',
    priority: 20,
    weight: 1,
    supported_models: ['gemini-2.5-flash'],
    last_success_at: new Date().toISOString(),
    last_error_at: null,
    last_error: null,
    cooldown_until: null,
    consecutive_errors: 0,
    request_count: 5,
    created_at: '',
    updated_at: '',
  };

  // Add accountA to db for database lookups in scheduler
  const { db } = await import('../db/database.js');
  db.createAccount(accountA);

  const accountB: GeminiAccount = {
    id: 'acc_b',
    name: 'Low Priority with Errors',
    email_label: 'b@example.com',
    encrypted_cookie: 'enc',
    auth_user: '0',
    status: 'ACTIVE',
    priority: 5,
    weight: 1,
    supported_models: ['gemini-2.5-flash'],
    last_success_at: null,
    last_error_at: new Date().toISOString(),
    last_error: 'transient',
    cooldown_until: null,
    consecutive_errors: 2,
    request_count: 1,
    created_at: '',
    updated_at: '',
  };

  const scoreA = scheduler.calculateScore(accountA);
  const scoreB = scheduler.calculateScore(accountB);
  assert(scoreA > scoreB, 'Healthy high-priority account scores higher than account with errors');

  scheduler.incrementActive(accountA.id);
  const scoreAWithLoad = scheduler.calculateScore(accountA);
  assert(scoreAWithLoad < scoreA, 'Active load penalty reduces account score proportionally');
  scheduler.decrementActive(accountA.id);

  // 5. Sticky Session
  console.log('\n--- Test Suite 5: Sticky Conversations ---');
  scheduler.setStickySession('conv_123', 'acc_a');
  assert(
    scheduler.getStickyAccount('conv_123', 'gemini-2.5-flash')?.id === 'acc_a',
    'Sticky session preserves conversation account mapping'
  );

  // 6. Quota Manager & Cooldown
  console.log('\n--- Test Suite 6: Quota Manager Cooldown Check ---');
  const quota = new QuotaManager();
  const futureCooldown = new Date(Date.now() + 600000).toISOString();
  assert(
    quota.isCoolingDown({ status: 'QUOTA_EXHAUSTED', cooldown_until: futureCooldown }),
    'Account in active cooldown detected as unavailable'
  );
  assert(
    !quota.isCoolingDown({ status: 'ACTIVE', cooldown_until: null }),
    'Active account is not cooling down'
  );

  // 7. OpenAI Response & SSE Formatting
  console.log('\n--- Test Suite 7: OpenAI Response & SSE Stream Mapping ---');
  const openAiResponse = OpenAIAdapter.toChatCompletionResponse('gemini-2.5-flash', {
    text: 'Hello world response',
    prompt_tokens: 5,
    completion_tokens: 8,
  });

  assert(openAiResponse.object === 'chat.completion', 'OpenAI response object format match');
  assert(openAiResponse.choices[0].message.content === 'Hello world response', 'Content mapping correct');
  assert(openAiResponse.usage.total_tokens === 13, 'Usage calculations correct');
  assert(openAiResponse.usage.estimated === true, 'Usage explicitly flagged with estimated: true');

  const chunkLine = OpenAIAdapter.toChatCompletionChunk('chatcmpl_123', 'gemini-2.5-flash', ' token_delta');
  assert(chunkLine.startsWith('data: ') && chunkLine.includes('chat.completion.chunk'), 'OpenAI SSE chunk matches wire format');

  // 8. Gateway API Key Authentication Suite
  console.log('\n--- Test Suite 8: Gateway API Key Authentication ---');
  const keyMgr = new ApiKeyManager();
  const validKey = generateApiKey();
  db.createApiKey({
    id: 'test_auth_key',
    name: 'Auth Test Key',
    key_prefix: validKey.prefix,
    key_hash: validKey.hash,
    enabled: true,
    allowed_models: ['*'],
    rpm_limit: 60,
    concurrent_limit: 10,
    daily_request_limit: 1000,
    expires_at: null,
    created_at: new Date().toISOString(),
    last_used_at: null,
  });

  const authSuccess = keyMgr.authenticate(`Bearer ${validKey.apiKey}`);
  assert(authSuccess.authenticated && authSuccess.apiKey?.id === 'test_auth_key', 'Valid sk-gmgw- key successfully authenticated');

  const legacyReject = keyMgr.authenticate(`Bearer gmgw_legacykey1234567890`);
  assert(!legacyReject.authenticated && legacyReject.error?.includes('Invalid API key format'), 'Legacy gmgw_ format strictly rejected');

  const invalidKeyReject = keyMgr.authenticate(`Bearer sk-gmgw-invalidnonexistentkey12345678`);
  assert(!invalidKeyReject.authenticated && invalidKeyReject.error?.includes('Invalid or revoked'), 'Non-existent sk-gmgw- key rejected with 401');

  db.deleteApiKey('test_auth_key');

  // 9. Multi-turn conversation persistence
  console.log('\n--- Test Suite 9: Multi-turn Conversation Persistence ---');
  const multiTurnAccount: GeminiAccount = {
    id: 'acc_multiturn_regression',
    name: 'Multi-turn Regression Account',
    email_label: 'multiturn@example.com',
    encrypted_cookie: 'enc',
    auth_user: '0',
    status: 'ACTIVE',
    priority: 100,
    weight: 10,
    supported_models: ['gemini-3.8-flash'],
    last_success_at: null,
    last_error_at: null,
    last_error: null,
    cooldown_until: null,
    consecutive_errors: 0,
    request_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const multiTurnApiKey: ApiKey = {
    id: 'key_multiturn_regression',
    name: 'Multi-turn Regression Key',
    key_prefix: 'sk-gmgw-regression',
    key_hash: 'regression-hash',
    enabled: true,
    allowed_models: ['*'],
    rpm_limit: 60,
    concurrent_limit: 5,
    daily_request_limit: 100,
    expires_at: null,
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
  const originalChatCompletion = geminiProvider.ChatCompletion.bind(geminiProvider);
  const observedRequests: any[] = [];
  db.createAccount(multiTurnAccount);
  (geminiProvider as any).ChatCompletion = async (_account: GeminiAccount, request: any) => {
    observedRequests.push({
      conversation_id: request.conversation_id,
      upstream_cid: request.upstream_cid,
      upstream_rid: request.upstream_rid,
      upstream_rcid: request.upstream_rcid,
    });
    const hasContext = Boolean(request.upstream_cid && request.upstream_rid && request.upstream_rcid);
    return {
      text: hasContext ? 'PHUONGHOANG2026' : 'Đã ghi nhớ từ khóa.',
      conversation_id: 'c_multiturn_regression',
      response_id: hasContext ? 'rid_2' : 'rid_1',
      choice_id: hasContext ? 'rcid_2' : 'rcid_1',
      prompt_tokens: 1,
      completion_tokens: 1,
    };
  };

  const testRequestPrefix = `req_multiturn_${Date.now()}`;
  try {
    const service = new GatewayService();
    const firstRequest: any = {
      model: 'gemini-3.8-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hãy ghi nhớ từ khóa bí mật: PHUONGHOANG2026' },
      ],
    };
    const first = await service.handleChatCompletion(firstRequest, multiTurnApiKey, `${testRequestPrefix}_1`);
    const conversationId = (first.response as any).conversation_id;
    assert(conversationId === 'c_multiturn_regression', 'First response exposes upstream conversation ID');
    assert(accountScheduler.getConversationAffinity(conversationId) === multiTurnAccount.id, 'First turn sets conversation affinity in RAM');

    const second = await service.handleChatCompletion(
      {
        ...firstRequest,
        conversation_id: conversationId,
        upstream_cid: conversationId,
        upstream_rid: (first.response as any).response_id,
        upstream_rcid: (first.response as any).choice_id,
        messages: [
          ...firstRequest.messages,
          { role: 'assistant', content: first.response.choices[0].message.content },
          { role: 'user', content: 'Từ khóa bí mật tôi vừa nói là gì?' },
        ],
      },
      multiTurnApiKey,
      `${testRequestPrefix}_2`
    );
    assert(second.response.choices[0].message.content === 'PHUONGHOANG2026', 'Second turn keeps conversational context');
    assert(observedRequests[1]?.upstream_cid === 'c_multiturn_regression', 'Second turn forwards inner[2] conversation ID');
    assert(observedRequests[1]?.upstream_rid === 'rid_1', 'Second turn forwards upstream response metadata');
    assert(observedRequests[1]?.upstream_rcid === 'rcid_1', 'Second turn forwards upstream choice metadata');
  } finally {
    (geminiProvider as any).ChatCompletion = originalChatCompletion;
    db.deleteAccount(multiTurnAccount.id);
    for (const log of db.getRequestLogs(1000).filter((item) => item.request_id.startsWith(testRequestPrefix))) {
      db.deleteRequestLog(log.request_id);
    }
  }

  // Clean up test account from database so db remains completely clean
  db.deleteAccount(accountA.id);

  // 10. Core Gemini Protocol Suite
  const { runProtocolTests } = await import('./gemini-protocol.test.js');
  await runProtocolTests();

  // 11. Regression Test Suite
  const { runRegressionTests } = await import('./regression.test.js');
  await runRegressionTests();

  console.log(`\n========================================`);
  console.log(`🏁 Test Results: ${testsPassed} Passed, ${testsFailed} Failed`);
  console.log(`========================================\n`);

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error('Test runner exception:', e);
  process.exit(1);
});
