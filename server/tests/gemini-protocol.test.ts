import {
  geminiAccountUrl,
  geminiSourcePath,
  cleanCookie,
  mergeCookieHeaders,
  extractThinkingAndText,
  geminiAccountCapacity,
  geminiModelNames,
  parseGeminiModels,
  resolveGeminiModel,
  buildGeminiModelHeaders,
  buildGenerateInner,
  extractBardError,
  parseGoogleWireResponse,
  parseGeminiQuotaResponse,
  DiscoveredModel,
  GEMINI_MODEL_HEADER_KEY,
  GEMINI_USAGE_INFO_RPC,
} from '../services/gemini-adapter/gemini-web.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: any) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}`, detail || '');
    failed++;
  }
}

export async function runProtocolTests() {
  console.log('\n🔬 Running Gemini Web Core Protocol Test Suite...\n');

  // 1. Google Multi-login URL routing & AuthUser
  console.log('--- Suite 1: Gemini Web Multi-login URL & Paths ---');
  const defaultAppUrl = geminiAccountUrl('https://gemini.google.com/app', '0');
  assert(defaultAppUrl === 'https://gemini.google.com/app', 'AuthUser 0 preserves standard endpoint');

  const slot2AppUrl = geminiAccountUrl('https://gemini.google.com/app', '2');
  assert(slot2AppUrl === 'https://gemini.google.com/u/2/app', 'AuthUser 2 maps to /u/2/app Google account slot');

  const slot2RpcUrl = geminiAccountUrl('https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate', '2');
  assert(slot2RpcUrl === 'https://gemini.google.com/u/2/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate', 'RPC endpoint maps to /u/2/ account slot');

  assert(geminiSourcePath('0') === '/app', 'geminiSourcePath returns /app for slot 0');
  assert(geminiSourcePath('2') === '/u/2/app', 'geminiSourcePath returns /u/2/app for slot 2');

  // 2. Cookie manipulation & normalization
  console.log('\n--- Suite 2: Cookie Cleaning & Header Merging ---');
  assert(cleanCookie(' "__Secure-1PSID=val123;" ') === '__Secure-1PSID=val123', 'cleanCookie strips quotes, semicolons and spaces');

  const merged = mergeCookieHeaders(
    'NID=rollout; __Secure-1PSID=old; SIDCC=account',
    '__Secure-1PSID=new; __Secure-1PSIDTS=fresh'
  );
  assert(merged.includes('NID=rollout'), 'Merged cookies preserve rollout NID');
  assert(merged.includes('__Secure-1PSID=new'), 'Merged cookies override 1PSID with fresh value');
  assert(!merged.includes('__Secure-1PSID=old'), 'Old overridden cookie does not leak in result');
  assert(merged.includes('__Secure-1PSIDTS=fresh'), 'Fresh 1PSIDTS preserved in merged header');

  // 3. Thinking & Reasoning extraction
  console.log('\n--- Suite 3: Gemini Thinking / Reasoning Protocol Parsing ---');
  const rawWithThought = '<ctrl94>thought\nStep 1: Calculate 2+2=4.\nStep 2: Add 1=5.<ctrl95>\nThe final answer is 5.';
  const { thinking, text } = extractThinkingAndText(rawWithThought);
  assert(thinking.includes('Step 1: Calculate 2+2=4.'), 'Thinking extracted correctly from <ctrl94> markers');
  assert(text === 'The final answer is 5.', 'Clean text stripped of thinking tags');

  const rawWithoutThought = 'Plain answer without thinking';
  const plainRes = extractThinkingAndText(rawWithoutThought);
  assert(plainRes.thinking === '', 'Empty thinking for plain text');
  assert(plainRes.text === 'Plain answer without thinking', 'Unchanged text for plain output');

  // 4. Gemini Account Capacity calculation
  console.log('\n--- Suite 4: Account Capacity Flags (matches Reference) ---');
  assert(JSON.stringify(geminiAccountCapacity([], [])) === JSON.stringify({ capacity: 1, capacityField: 12 }), 'Free tier default capacity (1, 12)');
  assert(JSON.stringify(geminiAccountCapacity([8], [])) === JSON.stringify({ capacity: 2, capacityField: 12 }), 'Pro tier 8 -> (2, 12)');
  assert(JSON.stringify(geminiAccountCapacity([], [19])) === JSON.stringify({ capacity: 2, capacityField: 12 }), 'Pro capability 19 -> (2, 12)');
  assert(JSON.stringify(geminiAccountCapacity([16, 8], [])) === JSON.stringify({ capacity: 3, capacityField: 12 }), 'Alternate pro tier 16 -> (3, 12)');
  assert(JSON.stringify(geminiAccountCapacity([16], [115, 19])) === JSON.stringify({ capacity: 4, capacityField: 12 }), 'Plus precedence capability 115 -> (4, 12)');
  assert(JSON.stringify(geminiAccountCapacity([21, 22, 16], [115])) === JSON.stringify({ capacity: 1, capacityField: 13 }), 'Field 13 override 21 -> (1, 13)');
  assert(JSON.stringify(geminiAccountCapacity([22, 8], [115])) === JSON.stringify({ capacity: 2, capacityField: 13 }), 'Field 13 override 22 -> (2, 13)');

  // 5. Model Registry Discovery Parser (otAQ7b fixture from Reference)
  console.log('\n--- Suite 5: Model Registry Discovery Parser ---');
  function createModelEntry(id: string, category: string, display: string, number: number) {
    const e = new Array(20).fill(null);
    e[0] = id;
    e[1] = category;
    e[11] = display;
    e[17] = number;
    return e;
  }

  function createModelFixture(statusCode: number, tiers: any[], capabilities: any[], entries: any[]) {
    const status = new Array(18).fill(null);
    status[14] = statusCode;
    status[15] = entries;
    status[16] = tiers;
    status[17] = capabilities;

    const record = [
      ['wrb.fr', 'otAQ7b', JSON.stringify(status), null, null, null, 'generic'],
    ];
    return `)]}'\n\n42\n[["wrb.fr","other-rpc","[]"]]\n${JSON.stringify(record).length}\n${JSON.stringify(record)}\n12\n[["di",0]]\n`;
  }

  const flashEntry = createModelEntry('account-flash-id', 'Fast', 'Gemini 3.8 Flash', 1);
  const proEntry = createModelEntry('account-pro-id', 'Pro', 'Gemini 3.1 Pro', 3);
  const discoveryPayload = createModelFixture(1000, [8], [], [flashEntry, proEntry]);

  const discovered = parseGeminiModels(discoveryPayload);
  assert(discovered.length === 2, 'Parsed 2 models from batchexecute discovery fixture');
  assert(discovered[0].id === 'gemini-3.8-flash', 'Canonical ID generated for Flash');
  assert(discovered[0].modelId === 'account-flash-id', 'Internal modelId mapped for Flash');
  assert(discovered[1].id === 'gemini-3.1-pro', 'Canonical ID generated for Pro');
  assert(discovered[1].modelNumber === 3, 'ModelNumber 3 mapped for Pro');
  assert(discovered[1].capacity === 2 && discovered[1].capacityField === 12, 'Capacity mapped from tier [8]');

  // Model resolution & alias matching
  const resolvedEmpty = resolveGeminiModel('', discovered);
  assert(resolvedEmpty.modelId === 'account-flash-id', 'Empty request resolves to first available model');

  const resolvedFlash = resolveGeminiModel('gemini-fast', discovered);
  assert(resolvedFlash.modelId === 'account-flash-id', 'gemini-fast alias resolves to Flash');

  const resolvedAdvanced = resolveGeminiModel('gemini-advanced', discovered);
  assert(resolvedAdvanced.modelId === 'account-pro-id', 'gemini-advanced alias resolves to Pro');

  const resolvedCanonicalPro = resolveGeminiModel('gemini-3.1-pro', discovered);
  assert(resolvedCanonicalPro.modelId === 'account-pro-id', 'gemini-3.1-pro canonical name resolves to Pro');

  let unknownErrorCaught = false;
  try {
    resolveGeminiModel('non-existent-model', discovered);
  } catch (err: any) {
    unknownErrorCaught = true;
    assert(err.message.includes('unsupported Gemini model'), 'Unknown model throws unsupported model error');
  }
  assert(unknownErrorCaught, 'Unknown model fails closed without silent fallback');

  // Rejection of invalid status
  let rejectErrorCaught = false;
  try {
    parseGeminiModels(createModelFixture(1014, [8], [], [flashEntry]));
  } catch (err: any) {
    rejectErrorCaught = true;
    assert(err.message.includes('status 1014'), 'Status 1014 rejected as unavailable session');
  }
  assert(rejectErrorCaught, 'Non-1000 status code rejected');

  // 6. Model Routing Headers Generation
  console.log('\n--- Suite 6: Model Selection Wire Headers ---');
  const testRequestId = 'TEST-REQ-ID-123';
  const testGenerationId = 'TEST-GEN-ID-456';
  const headers = buildGeminiModelHeaders(discovered[1], testRequestId, testGenerationId);

  assert(headers[GEMINI_MODEL_HEADER_KEY] !== undefined, 'Contains x-goog-ext-525001261-jspb model header');
  const parsedModelHeader = JSON.parse(headers[GEMINI_MODEL_HEADER_KEY]);
  assert(parsedModelHeader[0] === 1, 'Header index 0 is 1');
  assert(parsedModelHeader[4] === 'account-pro-id', 'Header index 4 has internal modelId');
  assert(parsedModelHeader[11] === 2, 'Header index 11 (field 12-1) has capacity 2');
  assert(parsedModelHeader[14] === 3, 'Header index 14 has modelNumber 3');
  assert(parsedModelHeader[16] === testGenerationId, 'Header index 16 has client generationId');

  assert(headers['x-goog-ext-525005358-jspb'] === JSON.stringify([testRequestId, 1]), 'Request ID header matches wire format [reqId, 1]');
  assert(headers['x-goog-ext-73010989-jspb'] === '[0]', 'Contains [0] extension header');
  assert(headers['x-goog-ext-73010990-jspb'] === '[0,0,0]', 'Contains [0,0,0] extension header');

  // 7. 81-Element GenerateInner Payload
  console.log('\n--- Suite 7: 81-Element Gemini Web Wire Payload ---');
  const innerPayload = buildGenerateInner('Hello Gemini!', 3, 'en', testRequestId, false, { cid: 'conv_abc' });
  assert(innerPayload.length === 81, 'GenerateInner has exactly 81 elements matching Reference wire protocol');
  assert(innerPayload[0][0] === 'Hello Gemini!', 'inner[0] contains prompt');
  assert(innerPayload[1][0] === 'en', 'inner[1] contains language');
  assert(innerPayload[2][0] === 'conv_abc', 'inner[2] contains conversation ID');
  assert(innerPayload[6][0] === 1, 'inner[6] contains [1]');
  assert(innerPayload[59] === testRequestId, 'inner[59] contains request UUID');
  assert(innerPayload[79] === 3, 'inner[79] contains modelNumber 3');
  assert(innerPayload[80] === 1, 'inner[80] contains 1');

  // 8. Real Response Wire Parser & BardErrorInfo
  console.log('\n--- Suite 8: Response Envelope & Error Parsing ---');
  const realWireResponse = `)]}'
[["wrb.fr",null,"[null,\\"cid_999\\",null,null,[[\\"rcid_888\\",[\\"Hello world from Gemini!\\"]]]]",null,null,null,"generic"]]`;

  const parsedWire = parseGoogleWireResponse(realWireResponse);
  assert(parsedWire.text === 'Hello world from Gemini!', 'Parsed response text correctly');
  assert(parsedWire.conversation_id === 'cid_999', 'Parsed conversation_id cid_999');
  assert(parsedWire.choice_id === 'rcid_888', 'Parsed choice_id rcid_888');

  // BardErrorInfo parsing
  const bardErrorPayload = `)]}'
[["wrb.fr",null,null,null,null,[13,null,[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1152]]]]],["di",2461]]`;

  let bardErrCaught = false;
  try {
    parseGoogleWireResponse(bardErrorPayload);
  } catch (err: any) {
    bardErrCaught = true;
    assert(err.message.includes('BardErrorInfo code 13 1152'), 'BardErrorInfo code 13 1152 properly detected and formatted');
  }
  assert(bardErrCaught, 'BardErrorInfo throws with diagnostic details');

  // 9. Gemini Web Quota (jSf9Qc) Wire Parser
  console.log('\n--- Suite 9: Gemini Web Quota (Usage Limits) RPC Parsing ---');
  const sampleQuotaWire = `)]}'
201
[["wrb.fr","jSf9Qc","[2,[[47740,0.01329433,2,[[1789705625,968490000]]],[1778,0.26,1,[[1789122425,968397000]]]],false]",null,null,null,"generic"]]`;

  const parsedQuota = parseGeminiQuotaResponse(sampleQuotaWire);
  assert(parsedQuota.tier === 'PRO', 'Parsed tier as PRO');
  assert(parsedQuota.current_usage_percent === 26, 'Parsed current usage percent as 26%');
  assert(parsedQuota.current_reset_label.includes('10:27 UTC'), 'Parsed current reset time formatted correctly');
  assert(parsedQuota.weekly_usage_percent === 1, 'Parsed weekly usage percent as 1%');
  assert(parsedQuota.weekly_reset_label.includes('18 thg 9 lúc 04:27 UTC'), 'Parsed weekly reset label formatted correctly');

  // 10. Extended Thinking Mode Selection & Activation
  console.log('\n--- Suite 10: Extended Thinking Mode Activation ---');
  const standardInner = buildGenerateInner('solve puzzle', 3, 'vi', 'req-1', false, undefined, undefined, 1);
  assert(standardInner[80] === 1, 'Standard mode sets inner[80] = 1');

  const thinkingInner = buildGenerateInner('solve complex math', 3, 'vi', 'req-2', false, undefined, undefined, 2);
  assert(thinkingInner[80] === 2, 'Extended thinking mode sets inner[80] = 2');

  const proResolved = resolveGeminiModel('gemini-3.1-pro-thinking', discovered);
  assert(proResolved.modelNumber === 3, 'gemini-3.1-pro-thinking correctly resolves to gemini-3.1-pro model');

  console.log(`\n========================================`);
  console.log(`🏁 Protocol Test Results: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('gemini-protocol.test.ts')) {
  runProtocolTests().catch((e) => {
    console.error('Fatal test error:', e);
    process.exit(1);
  });
}
