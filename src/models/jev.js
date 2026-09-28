import { getKey } from '../utils/keys.js';

// Builds on implementation_drafts/jev._possibly_working.js and
// implementation_drafts/minecraft2d_and_decisions/ai/jev_client.py
//
// Jev (typesafe/jev-1.13) is a System-One decision model on OpenRouter.
// It does NOT generate text: it answers typed questions (choice/noul/score)
// with probabilities. See the Jev tutorial + Decisions API reference.
export class Jev {
    static prefix = 'jev';

    constructor(model_name, url, params = {}) {
        this.model_name = model_name || 'typesafe/jev-1.13';
        this.url = url || 'https://openrouter.ai/api/alpha/decisions';
        this.params = params || {};
        // Verbose decision logging. Opt out with { verbose: false } or JEV_VERBOSE=0.
        this.verbose = this.params.verbose ?? process.env.JEV_VERBOSE !== '0';
        this.last_meta = null;
        this.total_calls = 0;
        this.total_cost = 0;
        this.total_input_tokens = 0;
        this.total_output_tokens = 0;
    }

    static choice(instructions, criteria) {
        return { type: 'choice', instructions, criteria };
    }

    static noul(instructions, trueCriteria, falseCriteria) {
        return {
            type: 'noul',
            instructions,
            criteria: { true: trueCriteria, false: falseCriteria }
        };
    }

    static score(instructions, criteria) {
        return { type: 'score', instructions, criteria };
    }

    async decide(state, questions, { timeout_ms = 15000, max_retries = 2 } = {}) {
        // DecisionsRequest.state accepts a plain string, JSON object or array.
        const stateType = typeof state;
        if (state === null || (stateType !== 'string' && stateType !== 'object')) {
            throw new TypeError('Jev decision state must be a string, object, or array.');
        }
        if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
            throw new TypeError('Jev decision questions must be an object.');
        }
        for (const [name, question] of Object.entries(questions)) {
            if (!question || typeof question !== 'object') {
                throw new TypeError(`Jev question "${name}" must be an object.`);
            }
            if (question?.type === 'choice') {
                const criteria = question.criteria;
                if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
                    throw new TypeError(`Jev choice question "${name}" must have object criteria.`);
                }
                const alternatives = Object.keys(criteria).length;
                if (alternatives < 1 || alternatives > 255) {
                    throw new RangeError(`Jev choice question "${name}" must have between 1 and 255 alternatives.`);
                }
            }
        }

        const headers = {
            Authorization: `Bearer ${getKey('OPENROUTER_API_KEY')}`,
            'Content-Type': 'application/json'
        };
        if (this.params.http_referer) headers['HTTP-Referer'] = this.params.http_referer;
        if (this.params.title) headers['X-OpenRouter-Title'] = this.params.title;

        const body = JSON.stringify({ model: this.model_name, state, questions });
        const stateKeys = state && typeof state === 'object' && !Array.isArray(state)
            ? Object.keys(state) : [Array.isArray(state) ? `array[${state.length}]` : typeof state];
        this.vlog(`-> POST ${this.url} model=${this.model_name} state={${stateKeys.join(',')}} (${body.length} bytes body)`);
        this.vlog('questions:', JSON.stringify(this.summarizeQuestions(questions), null, 1));
        if (this.verbose && state && typeof state === 'object') {
            this.vlog('state:', JSON.stringify(state).slice(0, 4000));
        }

        let lastError = null;
        const started = Date.now();
        for (let attempt = 0; attempt <= max_retries; attempt++) {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), timeout_ms);
                let response;
                try {
                    response = await fetch(this.url, {
                        method: 'POST',
                        headers,
                        body,
                        signal: ctrl.signal
                    });
                } finally {
                    clearTimeout(t);
                }
                if (!response.ok) {
                    const details = await response.text().catch(() => '');
                    throw new Error(`OpenRouter Jev request failed (${response.status}): ${details}`);
                }
                const result = await response.json();
                if (!result?.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) {
                    throw new Error('OpenRouter Jev response did not contain an answers object.');
                }
                this.total_calls++;
                const usage = result.usage || {};
                this.total_cost += usage.cost || 0;
                this.total_input_tokens += usage.input_tokens || 0;
                this.total_output_tokens += usage.output_tokens || 0;
                const elapsed = Date.now() - started;
                this.last_meta = { id: result.id, model: result.model, provider: result.provider };
                this.vlog(`<- 200 in ${elapsed}ms usage=${JSON.stringify(usage)} total=${this.statsSummary()}`);
                this.vlog('raw answers:', JSON.stringify(result.answers));
                this.logAnswers(result.answers, this.last_meta);
                return result.answers;
            } catch (err) {
                lastError = err;
                console.warn(`Jev decision attempt ${attempt + 1}/${max_retries + 1} failed: ${err?.message || err}`);
                if (attempt < max_retries) {
                    await new Promise(r => setTimeout(r, 200 * (2 ** attempt)));
                }
            }
        }
        throw lastError;
    }

    vlog(...args) {
        if (this.verbose) console.log('[jev]', ...args);
    }

    summarizeQuestions(questions) {
        const out = {};
        for (const [name, q] of Object.entries(questions)) {
            if (q?.type === 'choice') {
                const keys = Object.keys(q.criteria || {});
                out[name] = { type: 'choice', alternatives: keys.length, ids: keys };
            } else if (q?.type === 'noul') {
                out[name] = { type: 'noul' };
            } else if (q?.type === 'score') {
                const criteria = Array.isArray(q.criteria) ? q.criteria : [];
                out[name] = { type: 'score', scale_size: criteria.length, scale: criteria };
            } else {
                out[name] = { type: q?.type || 'unknown' };
            }
        }
        return out;
    }

    logAnswers(answers, meta) {
        if (!this.verbose) return;
        for (const [name, a] of Object.entries(answers || {})) {
            if (!a || typeof a !== 'object') {
                this.vlog(`answer ${name}:`, JSON.stringify(a));
                continue;
            }
            if (a.type === 'choice') {
                const probs = a.probabilities || {};
                const ranked = Object.entries(probs).sort((x, y) => y[1] - x[1]).slice(0, 8);
                this.vlog(`answer ${name}: choice=${a.choice} confidence=${a.confidence}`);
                for (const [id, p] of ranked) this.vlog(`    p(${id})=${Number(p).toFixed(4)}`);
            } else if (a.type === 'noul') {
                this.vlog(`answer ${name}: noul P(yes)=${a.noul}`);
            } else if (a.type === 'score') {
                this.vlog(`answer ${name}: score=${a.score} confidence=${a.confidence} legend=${JSON.stringify(a.legend || {})}`);
            } else {
                this.vlog(`answer ${name}:`, JSON.stringify(a));
            }
        }
        if (meta) {
            this.vlog(`served by model=${meta.model || '?'} provider=${meta.provider || '?'} id=${meta.id || '?'}`);
        }
    }

    statsSummary() {
        return `Jev stats: ${this.total_calls} calls, ${this.total_input_tokens} in-tokens, ${this.total_output_tokens} out-tokens, $${this.total_cost.toFixed(5)} cost`;
    }

    // Chat-model compatibility shim. Jev is NOT a chat model, so the normal
    // agent Prompter cannot use it for dialogue/codegen. Fail loudly with
    // guidance instead of returning a hallucinated string.
    async sendRequest() {
        throw new Error(
            'Jev (typesafe/jev-1.13) is a decision model, not a chat model: ' +
            'use jev.decide(state, questions) or the JevProgression controller ' +
            '(src/agent/jev/) instead of sendRequest().'
        );
    }

    async embed() {
        throw new Error('Embeddings are not supported by Jev.');
    }
}
