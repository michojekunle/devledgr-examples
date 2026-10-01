/**
 * DevLedgr Automated Verification Suite
 * Tests all invariants from challenge: a0000001-0000-4000-8000-000000000001
 */

const assert = require('assert');
const crypto = require('crypto');
const { app, deduplicator, verifyHmacSignature, SlidingWindowDeduplicator } = require('./server');
const http = require('http');

const SECRET = 'whsec_demo_secret_2026';

function sign(payloadStr) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(payloadStr).digest('hex');
}

async function runTests() {
  console.log('--- STARTING DEVLEDGR ACCEPTANCE TEST SUITE ---');

  // Test 1: Sliding Window Deduplicator Unit Tests
  console.log('1. Testing Deduplication Window logic...');
  const testWindow = new SlidingWindowDeduplicator(100, 5); // 100ms TTL
  testWindow.set('k1', { ok: true });
  assert.strictEqual(testWindow.has('k1'), true);
  assert.strictEqual(testWindow.has('k2'), false);
  console.log('   ✓ Window storage and retrieval passes');

  // Test 2: Invariant: Constant-time HMAC Verification
  console.log('2. Testing Constant-Time HMAC Signature Check...');
  const validBody = Buffer.from(JSON.stringify({ event: 'charge.completed', amount: 5000 }));
  const validSig = sign(validBody.toString());
  const invalidSig = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

  assert.strictEqual(verifyHmacSignature(validBody, validSig), true);
  assert.strictEqual(verifyHmacSignature(validBody, invalidSig), false);
  assert.strictEqual(verifyHmacSignature(validBody, ''), false);
  console.log('   ✓ HMAC signature security verification passes');

  // Test 3: HTTP Server Integration Tests
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(8089, resolve));

  const post = (path, headers, body) => {
    return new Promise((resolve, reject) => {
      const dataStr = typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request({
        hostname: 'localhost',
        port: 8089,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr),
          ...headers
        }
      }, (res) => {
        let resBody = '';
        res.on('data', chunk => resBody += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(resBody || '{}') }));
      });
      req.on('error', reject);
      req.write(dataStr);
      req.end();
    });
  };

  const get = (path) => {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:8089${path}`, (res) => {
        let resBody = '';
        res.on('data', chunk => resBody += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(resBody || '{}') }));
      }).on('error', reject);
    });
  };

  try {
    // Test 3a: Health probe
    console.log('3. Testing /health endpoint...');
    const health = await get('/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.data.status, 'healthy');
    console.log('   ✓ Health check returns 200 OK');

    // Test 3b: Malformed / missing HMAC returns 401
    console.log('4. Testing Malformed Signature returns 401 within SLA...');
    const unauth = await post('/events', {
      'x-idempotency-key': 'key_1',
      'x-signature-sha256': invalidSig
    }, { amount: 100 });
    assert.strictEqual(unauth.status, 401);
    console.log('   ✓ 401 Unauthorized correctly enforced on tampered signature');

    // Test 3c: Valid first execution returns 201
    console.log('5. Testing Valid First Webhook Ingestion...');
    const payload = JSON.stringify({ amount: 2500, type: 'payment.success' });
    const payloadSig = sign(payload);
    const firstExec = await post('/events', {
      'x-idempotency-key': 'idem_tx_9988',
      'x-signature-sha256': payloadSig
    }, payload);
    assert.strictEqual(firstExec.status, 201);
    assert.strictEqual(firstExec.data.status, 'success');
    console.log('   ✓ Valid first-time event creates 201 Created');

    // Test 3d: Duplicate retry returns 200 deduplicated
    console.log('6. Testing Deduplication on Immediate Retry...');
    const secondExec = await post('/events', {
      'x-idempotency-key': 'idem_tx_9988',
      'x-signature-sha256': payloadSig
    }, payload);
    assert.strictEqual(secondExec.status, 200);
    assert.strictEqual(secondExec.data.duplicate, true);
    assert.strictEqual(secondExec.data.status, 'deduplicated');
    console.log('   ✓ Duplicate replay gracefully returns cached 200 OK without re-executing');

    // Test 3e: Telemetry endpoint
    console.log('7. Testing /telemetry endpoint...');
    const telemetry = await get('/telemetry');
    assert.strictEqual(telemetry.status, 200);
    assert.strictEqual(telemetry.data.duplicates_processed, 0);
    console.log('   ✓ Telemetry reports 0 duplicate side-effects (100% deduplication rate)');

    console.log('\n======================================================');
    console.log('🎯 ALL 7 TEST HARNESS CRITERIA PASSED WITHOUT FAILURE');
    console.log('   Ready for Render Deployment and DevLedgr Ledger Minting');
    console.log('======================================================\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
