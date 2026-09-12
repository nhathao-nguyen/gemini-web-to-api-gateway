import assert from 'assert';
import { parseProxy, getProfileDir, getProfileBaseDir } from '../services/browser-manager/stealth-factory.js';
import { keepAliveWorker } from '../services/browser-manager/keepalive-worker.js';
import { db } from '../db/database.js';

console.log('\n🧪 Running Browser Manager & Keep-Alive Test Suite...\n');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    process.exitCode = 1;
  }
}

async function runTests() {
  // Isolated temp DB: never touch the real desktop gateway.db.
  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs');
  const isolatedDir = fs.default.mkdtempSync(path.default.join(os.default.tmpdir(), 'gw-bm-test-'));
  db.initializeSqlite(path.default.join(isolatedDir, 'test-browser.db'));
  await db.init();

  // Test 1: Proxy Parser
  await test('parseProxy returns undefined for empty or null input', () => {
    assert.strictEqual(parseProxy(''), undefined);
    assert.strictEqual(parseProxy(null), undefined);
    assert.strictEqual(parseProxy('   '), undefined);
  });

  await test('parseProxy parses standard http proxy without auth', () => {
    const res = parseProxy('http://192.168.1.100:8080');
    assert.ok(res);
    assert.strictEqual(res.server, 'http://192.168.1.100:8080');
    assert.strictEqual(res.username, undefined);
    assert.strictEqual(res.password, undefined);
  });

  await test('parseProxy parses socks5 proxy with username and password', () => {
    const res = parseProxy('socks5://myuser:secret123@proxy.example.com:1080');
    assert.ok(res);
    assert.strictEqual(res.server, 'socks5://proxy.example.com:1080');
    assert.strictEqual(res.username, 'myuser');
    assert.strictEqual(res.password, 'secret123');
  });

  await test('parseProxy decodes percent-encoded credentials', () => {
    const res = parseProxy('http://user%40corp:pass%21@10.0.0.1:3128');
    assert.ok(res);
    assert.strictEqual(res.username, 'user@corp');
    assert.strictEqual(res.password, 'pass!');
  });

  // Test 2: Profile Isolation Paths
  await test('getProfileDir sanitizes account ID and returns isolated path', () => {
    const dir = getProfileDir('acc_test_123');
    assert.ok(dir.includes('browser-profiles'));
    assert.ok(dir.endsWith('acc_test_123'));
  });

  // Test 3: KeepAlive Worker Telemetry & Sequential Lock
  await test('keepAliveWorker provides accurate status report', () => {
    const status = keepAliveWorker.getStatus();
    assert.strictEqual(typeof status.isWorkerRunning, 'boolean');
    assert.strictEqual(typeof status.isCurrentlyRefreshing, 'boolean');
    assert.strictEqual(typeof status.totalRefreshedSuccess, 'number');
    assert.strictEqual(typeof status.totalRefreshedFailed, 'number');
  });

  await test('keepAliveWorker handles non-existent account gracefully', async () => {
    const res = await keepAliveWorker.refreshAccount('acc_does_not_exist_999');
    assert.strictEqual(res.success, false);
    assert.ok(res.message.includes('not found'));
  });

  // Test 4: Desktop login moved to Electron (login.ts). The Playwright
  // onboarding service was removed; profile dirs follow GATEWAY_PROFILE_DIR.
  await test('getProfileDir honors GATEWAY_PROFILE_DIR override', async () => {
    const prev = process.env.GATEWAY_PROFILE_DIR;
    const path = await import('path');
    const overrideDir = path.join('gw-profiles-test-override');
    process.env.GATEWAY_PROFILE_DIR = overrideDir;
    try {
      assert.strictEqual(getProfileBaseDir(), overrideDir);
      assert.ok(getProfileDir('acc_x').startsWith(path.resolve(overrideDir)));
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_PROFILE_DIR;
      else process.env.GATEWAY_PROFILE_DIR = prev;
    }
  });

  await test('desktop login store completes external session with valid cookie', async () => {
    const { createPendingLogin, consumeCaptureToken, completeLoginWithCookie } = await import(
      '../services/browser-manager/desktop-login-store.js'
    );
    const pending = createPendingLogin({ mode: 'external', name: 'Ext Test Acc', emailLabel: 'ext@test.com' });
    assert.ok(pending.sessionId.startsWith('login_'));
    assert.ok(pending.captureToken.startsWith('cap_'));
    assert.strictEqual(pending.mode, 'external');

    const viaToken = consumeCaptureToken(pending.captureToken);
    assert.ok(viaToken);
    assert.strictEqual(viaToken.sessionId, pending.sessionId);
    // Single-use: second consume fails
    assert.strictEqual(consumeCaptureToken(pending.captureToken), undefined);

    // Re-arm not needed on success path; complete with a fresh valid cookie
    const done = completeLoginWithCookie(pending.sessionId, '__Secure-1PSID=psid_ext_1; __Secure-1PSIDTS=ts_ext_1');
    assert.strictEqual(done.step, 'COMPLETED');
    assert.ok(done.account);
    db.deleteAccount(done.account.id);
  });

  await test('desktop login store rejects invalid cookie and unknown token', async () => {
    const { createPendingLogin, consumeCaptureToken, completeLoginWithCookie } = await import(
      '../services/browser-manager/desktop-login-store.js'
    );
    assert.strictEqual(consumeCaptureToken('cap_nonexistent'), undefined);
    const pending = createPendingLogin({ mode: 'external', name: 'Ext Bad Cookie' });
    let threw = false;
    try {
      completeLoginWithCookie(pending.sessionId, 'garbage-no-cookie');
    } catch {
      threw = true;
    }
    assert.ok(threw);
    const { cancelLoginSession, getLoginSession } = await import(
      '../services/browser-manager/desktop-login-store.js'
    );
    assert.ok(cancelLoginSession(pending.sessionId));
    assert.strictEqual(getLoginSession(pending.sessionId)?.step, 'CANCELLED');
  });

  await test('chrome profile discovery lists cookie-bearing profiles', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { listChromeProfiles, snapshotFileList, mergeCookiesToHeader } = await import(
      '../services/browser-manager/profile-snapshot.js'
    );
    const root = fs.default.mkdtempSync(path.default.join(os.default.tmpdir(), 'gw-prof-test-'));
    try {
      fs.default.mkdirSync(path.default.join(root, 'Default', 'Network'), { recursive: true });
      fs.default.writeFileSync(path.default.join(root, 'Default', 'Network', 'Cookies'), 'x');
      fs.default.mkdirSync(path.default.join(root, 'Profile 1', 'Network'), { recursive: true });
      fs.default.writeFileSync(path.default.join(root, 'Profile 1', 'Network', 'Cookies'), 'x');
      fs.default.mkdirSync(path.default.join(root, 'Profile 9'));
      fs.default.writeFileSync(path.default.join(root, 'Local State'), '{}');
      assert.deepStrictEqual(listChromeProfiles(root), ['Default', 'Profile 1']);
      assert.ok(snapshotFileList('Default').includes('Local State'));
      assert.strictEqual(
        mergeCookiesToHeader([
          { name: 'A', value: '1' },
          { name: 'A', value: '2' },
          { name: 'B', value: '3' },
        ]),
        'A=2; B=3'
      );
    } finally {
      fs.default.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('desktop login session shape is compatible with UI polling', async () => {
    // Static contract check: the store owns the step machine the renderer
    // polls (INITIALIZING..COMPLETED/CANCELLED/TIMED_OUT/ERROR) and the
    // Electron shell drives it (no overlapping setInterval anywhere).
    const fs = await import('fs');
    const path = await import('path');
    const storeCode = fs.default.readFileSync(
      path.default.join(process.cwd(), 'server', 'services', 'browser-manager', 'desktop-login-store.ts'),
      'utf-8'
    );
    for (const step of ['INITIALIZING', 'WAITING_LOGIN', 'EXTRACTING', 'COMPLETED', 'CANCELLED', 'TIMED_OUT', 'ERROR']) {
      assert.ok(storeCode.includes(`'${step}'`), `login store covers step ${step}`);
    }
    const loginCode = fs.default.readFileSync(
      path.default.join(process.cwd(), 'electron', 'login.ts'),
      'utf-8'
    );
    assert.ok(loginCode.includes('desktop-login-store.js'), 'electron login shell drives the shared store');
    assert.ok(!loginCode.includes('setInterval('), 'login shell uses no overlapping setInterval polling');
  });

  console.log(`\n========================================`);
  console.log(`🏁 Browser Manager Test Results: ${passed} Passed`);
  console.log(`========================================\n`);
  process.exit(process.exitCode ?? 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
