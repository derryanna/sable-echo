// Wire/read ported from Jeved. Copyright (c) 2026 Jeved contributors. MIT; see vendor/jeved/LICENSE.
export const HOSTS = {
    rout: { endpoint: 'https://api.rout.my/v1/systemone', model: 'typesafe/jev-latest' },
    openrouter: { endpoint: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
    nanogpt: { endpoint: 'https://nano-gpt.com/api/v1/decisions', model: 'typesafe/jev-1.13' },
    custom: { endpoint: '', model: '' },
};
export const hostOf = id => Object.hasOwn(HOSTS, id) ? { id, ...HOSTS[id] } : null;
export function resolveHost(settings = {}) {
    const host = hostOf(settings.host) ?? hostOf('rout');
    return { endpoint: host.id === 'custom' ? String(settings.endpoint ?? '').trim() : host.endpoint,
        model: host.id === 'custom' ? String(settings.model ?? '').trim() : host.model,
        apiKey: String(settings.apiKey ?? '').trim() };
}

export function JevError(kind, message) {
    const error = new Error(message);
    error.name = 'JevError';
    error.kind = kind;
    Object.setPrototypeOf(error, JevError.prototype);
    return error;
}
JevError.prototype = Object.create(Error.prototype, { constructor: { value: JevError } });

const within = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
export function wire(spec) {
    const result = { type: spec.type, instructions: String(spec.question ?? '') };
    if (spec.type === 'score') result.criteria = (spec.levels ?? []).map(level => String(level ?? ''));
    if (spec.type === 'choice') result.criteria = Object.fromEntries((spec.options ?? [])
        .filter(o => o && typeof o.name === 'string' && o.name.trim()).map(o => [o.name.trim(), String(o.description ?? '')]));
    if (spec.type === 'noul' && spec.levels?.[0]?.trim() && spec.levels?.[1]?.trim()) {
        result.criteria = { false: spec.levels[0].trim(), true: spec.levels[1].trim() };
    }
    return result;
}
export function read(answer, spec) {
    if (spec.type === 'noul') return within(answer?.noul, 1) ? { value: answer.noul } : null;
    const value = spec.type === 'choice' ? answer?.choice : answer?.score;
    const valid = spec.type === 'choice' ? typeof value === 'string' && (spec.options ?? []).some(o => o.name.trim() === value)
        : within(value, (spec.levels?.length || 5) - 1);
    if (!valid) return null;
    return { value, confidence: within(answer?.confidence, 1) ? answer.confidence : undefined,
        probabilities: answer?.probabilities && typeof answer.probabilities === 'object' && !Array.isArray(answer.probabilities)
            ? answer.probabilities : undefined };
}

export async function ask({ endpoint, apiKey, model, state, questions, signal, timeoutMs = 20000,
    fetch = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (typeof endpoint !== 'string' || !endpoint.trim() || typeof model !== 'string' || !model.trim()) throw new JevError('config', 'Endpoint and model are required.');
    const controller = new AbortController();
    let timer, onAbort;
    const cancelled = new Promise((_, reject) => {
        onAbort = () => { controller.abort(); reject(new JevError('timeout', 'Request cancelled or timed out.')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(onAbort, timeoutMs);
        if (signal?.aborted) onAbort();
    });
    const run = async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (controller.signal.aborted) throw new JevError('timeout', 'Request cancelled or timed out.');
            let response;
            try {
                response = await fetch(endpoint, { method: 'POST', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? ''}` },
                    body: JSON.stringify({ model, state, questions }) });
            } catch (error) {
                throw new JevError(error?.name === 'AbortError' || controller.signal.aborted ? 'timeout' : 'network',
                    'Request could not be completed.');
            }
            if (attempt === 0 && [429, 529].includes(response.status)) { await sleep(2000); continue; }
            let data;
            try { data = await response.json(); } catch (error) {
                if (error?.name === 'AbortError' || controller.signal.aborted) {
                    throw new JevError('timeout', 'Request cancelled or timed out.');
                }
                data = null;
            }
            if (!response.ok) {
                const status = response.status;
                const message = data?.error?.message ?? data?.message;
                const kind = [401, 403].includes(status) ? 'key' : status === 402 ? 'credit'
                    : status === 404 || (status === 400 && typeof message === 'string' && message.trim()) ? 'config' : 'other';
                throw new JevError(kind, `Jev request failed (${status}).`);
            }
            if (!data?.answers || typeof data.answers !== 'object' || Array.isArray(data.answers)) {
                throw new JevError('other', 'Invalid answers payload.');
            }
            const usage = { ...(data.usage ?? {}) };
            if (usage.prompt_tokens !== undefined) { usage.input_tokens = usage.prompt_tokens; delete usage.prompt_tokens; }
            return { answers: data.answers, usage };
        }
    };
    try { return await Promise.race([cancelled, run()]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

