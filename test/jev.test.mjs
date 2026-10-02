import test from 'node:test';
import assert from 'node:assert/strict';
import { ask, JevError, HOSTS, hostOf, resolveHost, wire, read } from '../src/jev.js';
const response = (status = 200, data = { answers: {}, usage: { prompt_tokens: 12, output_tokens: 3 } }) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const options = { endpoint: '/decisions', model: 'test-model', apiKey: 'test-key', state: { latest_turn: 'Synthetic.' }, questions: {} };
const rejectsKind = (promise, kind) => assert.rejects(promise, e => e instanceof JevError && e instanceof Error && e.kind === kind && e.message.length > 0);

test('host resolution uses the specified built-in models and custom overrides only for custom', () => {
    assert.deepEqual(Object.keys(HOSTS), ['rout', 'openrouter', 'nanogpt', 'custom']);
    for (const id of ['rout', 'openrouter', 'nanogpt']) {
        assert.deepEqual(resolveHost({ host: id, apiKey: ' key ', endpoint: 'ignored', model: 'ignored' }), { ...HOSTS[id], apiKey: 'key' });
    }
    assert.equal(hostOf('unknown'), null);
    assert.equal(hostOf('toString'), null);
    assert.deepEqual(resolveHost({ host: 'custom', endpoint: ' /decisions ', model: ' custom ', apiKey: ' key ' }), { endpoint: '/decisions', model: 'custom', apiKey: 'key' });
});
test('ask posts the exact wire body with authentication and normalizes usage', async () => {
    const result = await ask({ ...options, fetch: async (url, init) => {
        assert.equal(url, options.endpoint);
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, 'Bearer test-key');
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(init.body), { model: options.model, state: options.state, questions: options.questions });
        assert.ok(init.signal instanceof AbortSignal);
        return response();
    } });
    assert.deepEqual(result, { answers: {}, usage: { input_tokens: 12, output_tokens: 3 } });
});
for (const status of [429, 529]) test(`ask retries HTTP ${status} once after two seconds`, async () => {
    let calls = 0;
    const sleeps = [];
    await ask({ ...options, fetch: async () => response(++calls === 1 ? status : 200), sleep: async ms => sleeps.push(ms) });
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [2000]);
    calls = 0;
    await rejectsKind(ask({ ...options, fetch: async () => { calls++; return response(status); }, sleep: async () => {} }), 'other');
    assert.equal(calls, 2);
});
for (const [status, kind, data] of [[401, 'key'], [403, 'key'], [402, 'credit'], [404, 'config'], [400, 'config', { error: { message: 'Unknown model' } }], [400, 'config', { message: 'Invalid input' }], [400, 'other'], [500, 'other']]) {
    test(`ask maps HTTP ${status} to ${kind}`, async () => {
        let calls = 0;
        await rejectsKind(ask({ ...options, fetch: async () => { calls++; return response(status, data); } }), kind);
        assert.equal(calls, 1);
    });
}
test('ask rejects missing configuration before making a request', async () => {
    const fetch = () => { assert.fail('Fetch must not run'); };
    await rejectsKind(ask({ ...options, endpoint: '', fetch }), 'config');
    await rejectsKind(ask({ ...options, model: ' ', fetch }), 'config');
});
test('ask maps fetch failure and AbortError to network and timeout', async () => {
    await rejectsKind(ask({ ...options, fetch: async () => { throw new TypeError('offline'); } }), 'network');
    await rejectsKind(ask({ ...options, fetch: async () => { throw new DOMException('aborted', 'AbortError'); } }), 'timeout');
});
test('ask times out even when fetch ignores its signal and aborts the request signal', async () => {
    let signal;
    await rejectsKind(ask({ ...options, timeoutMs: 5, fetch: (_, init) => { signal = init.signal; return new Promise(() => {}); } }), 'timeout');
    assert.equal(signal.aborted, true);
});
test('ask responds to external cancellation including during retry sleep', async () => {
    const controller = new AbortController();
    const request = ask({ ...options, signal: controller.signal, fetch: async () => response(429), sleep: async () => { controller.abort(); } });
    await rejectsKind(request, 'timeout');
    await rejectsKind(ask({ ...options, signal: AbortSignal.abort(), fetch: () => assert.fail('Already cancelled') }), 'timeout');
});
test('ask rejects malformed payloads and retains existing input token usage', async () => {
    for (const data of [null, {}, { answers: [] }]) await rejectsKind(ask({ ...options, fetch: async () => response(200, data) }), 'other');
    await rejectsKind(ask({ ...options, fetch: async () => ({ ...response(), json: async () => { throw new SyntaxError(); } }) }), 'other');
    assert.deepEqual((await ask({ ...options, fetch: async () => response(200, { answers: {}, usage: { input_tokens: 7 } }) })).usage, { input_tokens: 7 });
});
test('wire and read preserve the three original sensor protocols', () => {
    const score = { type: 'score', question: 'Rate', levels: ['Low', 'High'] };
    const choice = { type: 'choice', question: 'Pick', options: [{ name: ' one ', description: 'First' }, { name: '', description: 'Unused' }] };
    const noul = { type: 'noul', question: 'Present', levels: ['No', 'Yes'] };
    assert.deepEqual(wire(score), { type: 'score', instructions: 'Rate', criteria: ['Low', 'High'] });
    assert.deepEqual(wire(choice), { type: 'choice', instructions: 'Pick', criteria: { one: 'First' } });
    assert.deepEqual(wire(noul), { type: 'noul', instructions: 'Present', criteria: { false: 'No', true: 'Yes' } });
    assert.deepEqual(wire({ type: 'noul', question: 'Present' }), { type: 'noul', instructions: 'Present' });
    assert.equal(read({ score: 0.5, confidence: 0.8 }, score).confidence, 0.8);
    assert.equal(read({ choice: 'one' }, choice).value, 'one');
    assert.equal(read({ noul: 0.3 }, noul).value, 0.3);
    for (const value of [NaN, Infinity, -1, 2, '0.5', null]) assert.equal(read({ score: value }, score), null);
    assert.equal(read({ choice: 'missing' }, choice), null);
    assert.equal(read({ noul: 1.1 }, noul), null);
    assert.equal(read({ score: 1, confidence: 7 }, score).confidence, undefined);
});

test('ask maps an aborted response body to timeout and bounds response body reads', async () => {
    await rejectsKind(ask({ ...options, fetch: async () => ({ ...response(), json: async () => { throw new DOMException('aborted', 'AbortError'); } }) }), 'timeout');
    await rejectsKind(ask({ ...options, timeoutMs: 5, fetch: async () => ({ ...response(), json: () => new Promise(() => {}) }) }), 'timeout');
});
test('ask cancellation during an active fetch returns promptly without retrying', async () => {
    const controller = new AbortController();
    let calls = 0, requestSignal;
    const request = ask({ ...options, signal: controller.signal, fetch: (_, init) => {
        calls++; requestSignal = init.signal; return new Promise(() => {});
    } });
    controller.abort();
    await rejectsKind(request, 'timeout');
    assert.equal(calls, 1);
    assert.equal(requestSignal.aborted, true);
});
