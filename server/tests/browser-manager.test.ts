import assert from 'assert';
import { parseProxy, getProfileDir, DEFAULT_USER_AGENT } from '../services/browser-manager/stealth-factory.js';
import { browserOnboardingService } from '../services/browser-manager/onboarding-service.js';
import { keepAliveWorker } from '../services/browser-manager/keepalive-worker.js';
import { db } from '../db/database.js';

console.log('\n🧪 Running Browser Manager & Keep-Alive Test Suite...\n');

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res
        .then(() => {
          console.log(`  ✅ [PASS] ${name}`);
          passed++;
        })
        .catch((err) => {
          console.error(`  ❌ [FAIL] ${name}:`, err.message);
          process.exitCode = 1;
        });
    } else {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    }
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    process.exitCode = 1;
  }
}

async function runTests() {
  await db.init();

  // Test 1: Proxy Parser
  test('parseProxy returns undefined for empty or null input', () => {
    assert.strictEqual(parseProxy(''), undefined);
    assert.strictEqual(parseProxy(null), undefined);
    assert.strictEqual(parseProxy('   '), undefined);
  });

  test('parseProxy parses standard http proxy without auth', () => {
    const res = parseProxy('http://192.168.1.100:8080');
    assert.ok(res);
    assert.strictEqual(res.server, 'http://192.168.1.100:8080');
    assert.strictEqual(res.username, undefined);
    assert.strictEqual(res.password, undefined);
  });

  test('parseProxy parses socks5 proxy with username and password', () => {
    const res = parseProxy('socks5://myuser:secret123@proxy.example.com:1080');
    assert.ok(res);
    assert.strictEqual(res.server, 'socks5://proxy.example.com:1080');
    assert.strictEqual(res.username, 'myuser');
    assert.strictEqual(res.password, 'secret123');
  });

  test('parseProxy decodes percent-encoded credentials', () => {
    const res = parseProxy('http://user%40corp:pass%21@10.0.0.1:3128');
    assert.ok(res);
    assert.strictEqual(res.username, 'user@corp');
    assert.strictEqual(res.password, 'pass!');
  });

  // Test 2: Profile Isolation Paths
  test('getProfileDir sanitizes account ID and returns isolated path', () => {
    const dir = getProfileDir('acc_test_123');
    assert.ok(dir.includes('browser-profiles'));
    assert.ok(dir.endsWith('acc_test_123'));
  });

  // Test 3: KeepAlive Worker Telemetry & Sequential Lock
  test('keepAliveWorker provides accurate status report', () => {
    const status = keepAliveWorker.getStatus();
    assert.strictEqual(typeof status.isWorkerRunning, 'boolean');
    assert.strictEqual(typeof status.isCurrentlyRefreshing, 'boolean');
    assert.strictEqual(typeof status.totalRefreshedSuccess, 'number');
    assert.strictEqual(typeof status.totalRefreshedFailed, 'number');
  });

  test('keepAliveWorker handles non-existent account gracefully', async () => {
    const res = await keepAliveWorker.refreshAccount('acc_does_not_exist_999');
    assert.strictEqual(res.success, false);
    assert.ok(res.message.includes('not found'));
  });

  // Test 4: Browser Onboarding Service
  test('browserOnboardingService starts session with correct parameters', async () => {
    const session = await browserOnboardingService.startSession({
      name: 'Test Onboard Acc',
      emailLabel: 'test@gmail.com',
      priority: 20,
      weight: 5,
    });

    assert.ok(session.sessionId.startsWith('onboard_'));
    assert.strictEqual(session.name, 'Test Onboard Acc');
    assert.strictEqual(session.priority, 20);
    assert.strictEqual(session.weight, 5);

    // Cancel to clean up
    await browserOnboardingService.cancelSession(session.sessionId);
    const updated = browserOnboardingService.getSession(session.sessionId);
    assert.ok(updated);
    assert.strictEqual(updated.step, 'CANCELLED');
  });

  console.log(`\n========================================`);
  console.log(`🏁 Browser Manager Test Results: ${passed} Passed`);
  console.log(`========================================\n`);
  process.exit(0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
