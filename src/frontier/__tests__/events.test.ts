import { describe, expect, it } from 'vitest';
import { CLAIM_CHECK_THRESHOLD, canonicalizeJson } from '../../journal/index.js';
import {
  FRONTIER_EVENT_TYPES, FRONTIER_MAX_BODY_BYTES, FRONTIER_MAX_CREDENTIAL_ID,
  FRONTIER_MAX_CREDENTIALS, FRONTIER_MAX_URL_BYTES, FRONTIER_REQUEST_HEADERS,
  FRONTIER_RESPONSE_HEADERS, FrontierValidationError, HEADER_TRUNCATION_MARK,
  HEADER_VALUE_LIMIT, WORLD_HEAD_RE, filterHeaders, validateBeginInput,
  validateFrontierEvent, validateFrontierUrl, validateOutcome,
} from '../events.js';

/**
 * The frontier vocabulary is the truth record's schema: every valid event must
 * validate to exactly its frozen data form, and every deviation — a query string
 * in a URL, a credential value, a node-shaped key, an incoherent terminal — must
 * be refused with the one typed error. The validators are pure: same input,
 * same output, no clock, no mutation.
 */

const CALL = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);
const WORLD_HEAD = 'b'.repeat(40);

const REQUEST: Record<string, unknown> = {
  call: CALL,
  group: GROUP,
  attempt: 0,
  method: 'POST',
  url: 'https://api.example.com/v1/messages',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  credentials: [{ id: 'llm', where: 'authorization' }],
  body: { encoding: 'utf8', sha256: SHA, bytes: 3, complete: true },
  world_head: WORLD_HEAD,
};

const RESPONSE: Record<string, unknown> = {
  call: CALL,
  status: 200,
  headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
  body: { encoding: 'binary', sha256: 'c'.repeat(64), bytes: 12, complete: true },
  timing: { durationMs: 42 },
  error: null,
};

// The exact RFC 8785 forms the two fixtures canonicalize to: keys sorted, no
// whitespace by construction. A renamed or added field cannot follow silently.
const REQUEST_CANONICAL = `{"attempt":0,"body":{"bytes":3,"complete":true,"encoding":"utf8",`
  + `"sha256":"${SHA}"},"call":"${CALL}","credentials":[{"id":"llm","where":"authorization"}],`
  + `"group":"${GROUP}","headers":{"accept":"application/json","content-type":"application/json"},`
  + `"method":"POST","url":"https://api.example.com/v1/messages","world_head":"${WORLD_HEAD}"}`;

const RESPONSE_CANONICAL = `{"body":{"bytes":12,"complete":true,"encoding":"binary",`
  + `"sha256":"${'c'.repeat(64)}"},"call":"${CALL}","error":null,`
  + `"headers":{"content-type":"application/json","x-request-id":"req_1"},`
  + `"status":200,"timing":{"durationMs":42}}`;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...REQUEST, ...overrides };
}

function response(opts: {
  status?: number | null; error?: unknown; complete?: boolean;
  headers?: Record<string, string>;
} = {}): Record<string, unknown> {
  const { status = 200, error = null, complete = true, headers } = opts;
  const base = {
    ...RESPONSE,
    status,
    error,
    body: { ...(RESPONSE['body'] as Record<string, unknown>), complete },
  };
  return headers === undefined ? base : { ...base, headers };
}

function refusal(run: () => unknown): void {
  expect(run).toThrow(FrontierValidationError);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('golden vectors', () => {
  it('validates http/request to its frozen data form, as a copy', () => {
    const out = validateFrontierEvent('http/request', REQUEST);
    expect(out).toEqual(REQUEST);
    expect(out).not.toBe(REQUEST);
    expect(canonicalizeJson(out)).toBe(REQUEST_CANONICAL);
  });

  it('validates http/response to its frozen data form', () => {
    const out = validateFrontierEvent('http/response', RESPONSE);
    expect(out).toEqual(RESPONSE);
    expect(canonicalizeJson(out)).toBe(RESPONSE_CANONICAL);
  });

  it('validates http/incomplete to its exact canonical form', () => {
    const out = validateFrontierEvent('http/incomplete', { call: CALL });
    expect(out).toEqual({ call: CALL });
    expect(canonicalizeJson(out)).toBe(`{"call":"${CALL}"}`);
  });

  it('is pure: a frozen input yields the same result twice without mutation', () => {
    const input = deepFreeze(structuredClone(REQUEST));
    const first = validateFrontierEvent('http/request', input);
    expect(validateFrontierEvent('http/request', input)).toEqual(first);
    expect(input).toEqual(REQUEST);
  });

  it('registers exactly the three frontier event types and refuses the rest', () => {
    expect([...FRONTIER_EVENT_TYPES].sort())
      .toEqual(['http/incomplete', 'http/request', 'http/response']);
    refusal(() => validateFrontierEvent('http/attempt', { call: CALL }));
  });

  it('exports the structural bounds the refusals name', () => {
    expect(FRONTIER_MAX_BODY_BYTES).toBe(32 * 1024 * 1024);
    expect(FRONTIER_MAX_URL_BYTES).toBe(4096);
    expect(FRONTIER_MAX_CREDENTIALS).toBe(4);
    expect(FRONTIER_MAX_CREDENTIAL_ID).toBe(64);
    expect(HEADER_VALUE_LIMIT).toBe(128);
    expect(HEADER_TRUNCATION_MARK).toBe('…[truncated]');
  });

  it('pins WORLD_HEAD_RE to 40 or 64 lowercase hex characters', () => {
    expect(WORLD_HEAD_RE.test('a'.repeat(40))).toBe(true);
    expect(WORLD_HEAD_RE.test('a'.repeat(64))).toBe(true);
    expect(WORLD_HEAD_RE.test('a'.repeat(39))).toBe(false);
    expect(WORLD_HEAD_RE.test('a'.repeat(41))).toBe(false);
    expect(WORLD_HEAD_RE.test('A'.repeat(40))).toBe(false);
    expect(WORLD_HEAD_RE.test(`${'a'.repeat(40)}\n`)).toBe(false);
  });
});

describe('validateFrontierUrl', () => {
  it.each([
    'https://api.example.com/v1/chat/completions',
    'https://api.example.com/v1/messages',
    'http://127.0.0.1:8080/v1',
    'https://[::1]:443/v1/search',
    'https://example.com/',
    'https://example.com/a%20b',
  ])('accepts %s unchanged', (url) => {
    expect(validateFrontierUrl(url)).toBe(url);
  });

  it('accepts exactly FRONTIER_MAX_URL_BYTES and refuses one byte more', () => {
    const base = 'https://example.com/';
    const max = base + 'a'.repeat(FRONTIER_MAX_URL_BYTES - base.length);
    expect(Buffer.byteLength(max, 'utf8')).toBe(FRONTIER_MAX_URL_BYTES);
    expect(validateFrontierUrl(max)).toBe(max);
    refusal(() => validateFrontierUrl(`${max}a`));
  });

  it.each([
    ['a query string', 'https://api.example.com/v1?key=secret'],
    ['a fragment', 'https://api.example.com/v1#fragment'],
    ['userinfo', 'https://user:pass@api.example.com/v1'],
    ['a bare userinfo', 'https://user@api.example.com/v1'],
    ['a space', 'https://api.example.com/a b'],
    ['a non-ASCII character', 'https://api.example.com/v1/é'],
    ['a control character', 'https://api.example.com/v1/\u0001'],
    ['a malformed percent escape', 'https://api.example.com/v1/%zz'],
    ['a non-http scheme', 'ftp://api.example.com/v1'],
    ['a relative URL', '/v1/messages'],
    ['no path', 'https://api.example.com'],
    ['an empty host', 'https:///v1'],
  ])('refuses a URL with %s', (_label, url) => {
    refusal(() => validateFrontierUrl(url));
  });
});

describe('filterHeaders', () => {
  it('keeps exactly the request allowlist, lowercasing and dropping the rest', () => {
    const filtered = filterHeaders({
      'content-type': 'application/json',
      Authorization: 'Bearer secret',
      accept: 'application/json',
      'x-api-key': 'secret',
      cookie: 'session=1',
      'request-id': 'response-only',
    }, 'request');
    expect(filtered).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
    });
  });

  it('keeps exactly the response allowlist', () => {
    const filtered = filterHeaders({
      'Content-Type': 'application/json',
      'Request-Id': 'r1',
      'X-Request-ID': 'r2',
      'Retry-After': '30',
      Accept: 'application/json',
      'Set-Cookie': 'session=1',
      'x-api-key': 'secret',
    }, 'response');
    expect(filtered).toEqual({
      'content-type': 'application/json',
      'request-id': 'r1',
      'x-request-id': 'r2',
      'retry-after': '30',
    });
  });

  it('lets the last value win on a case collision', () => {
    expect(filterHeaders({ 'Content-Type': 'first', 'content-type': 'last' }, 'request'))
      .toEqual({ 'content-type': 'last' });
    expect(filterHeaders({ 'content-type': 'last', 'Content-Type': 'first' }, 'request'))
      .toEqual({ 'content-type': 'first' });
  });

  it('leaves a value at the limit untouched and truncates one code point over', () => {
    const atLimit = 'x'.repeat(HEADER_VALUE_LIMIT);
    expect(filterHeaders({ 'content-type': atLimit }, 'request'))
      .toEqual({ 'content-type': atLimit });
    const prefixLength = HEADER_VALUE_LIMIT - Array.from(HEADER_TRUNCATION_MARK).length;
    const over = filterHeaders({ 'content-type': 'x'.repeat(HEADER_VALUE_LIMIT + 1) }, 'request');
    expect(over['content-type']).toBe(`${'x'.repeat(prefixLength)}${HEADER_TRUNCATION_MARK}`);
    expect(Array.from(over['content-type'] as string)).toHaveLength(HEADER_VALUE_LIMIT);
  });

  it('never splits a surrogate pair at the cut point', () => {
    const prefixLength = HEADER_VALUE_LIMIT - Array.from(HEADER_TRUNCATION_MARK).length;
    const astralAtCut = 'a'.repeat(prefixLength - 1) + '😀' + 'b'.repeat(20);
    const out = filterHeaders({ 'content-type': astralAtCut }, 'request')['content-type'] as string;
    expect(out).toBe(`${'a'.repeat(prefixLength - 1)}😀${HEADER_TRUNCATION_MARK}`);
    expect(out.isWellFormed()).toBe(true);
    expect(Array.from(out)).toHaveLength(HEADER_VALUE_LIMIT);

    const allAstral = filterHeaders({ 'content-type': '😀'.repeat(300) }, 'response')['content-type'];
    expect(allAstral).toBe(`${'😀'.repeat(prefixLength)}${HEADER_TRUNCATION_MARK}`);
    expect((allAstral as string).isWellFormed()).toBe(true);
  });

  it('normalizes lone surrogates before measuring, so its output is well-formed', () => {
    const lone = filterHeaders({ 'content-type': '\uD800' }, 'request')['content-type'] as string;
    expect(lone).toBe('\uFFFD');
    expect(lone.isWellFormed()).toBe(true);

    const loneLow = filterHeaders({ 'content-type': 'a\uDC00b' }, 'request')['content-type'];
    expect(loneLow).toBe('a\uFFFDb');

    const many = filterHeaders({ 'content-type': '\uD800'.repeat(200) }, 'request')['content-type'];
    expect((many as string).isWellFormed()).toBe(true);
    expect(Array.from(many as string)).toHaveLength(HEADER_VALUE_LIMIT);
    expect(many).toBe(`${'\uFFFD'.repeat(116)}${HEADER_TRUNCATION_MARK}`);
  });

  it('produces only payloads the validators accept, in both directions', () => {
    const values = [
      '',
      'application/json',
      'x'.repeat(HEADER_VALUE_LIMIT),
      'x'.repeat(HEADER_VALUE_LIMIT + 1),
      '😀'.repeat(300),
      `${'a'.repeat(115)}😀${'b'.repeat(20)}`,
      '\u0001'.repeat(500),
      '\uD800',
      'a\uDC00b',
      '\uD800'.repeat(200),
    ];
    for (const name of FRONTIER_REQUEST_HEADERS) {
      for (const value of values) {
        const headers = filterHeaders({ [name]: value }, 'request');
        expect(() => validateFrontierEvent('http/request', request({ headers })), name)
          .not.toThrow();
      }
    }
    for (const name of FRONTIER_RESPONSE_HEADERS) {
      for (const value of values) {
        const headers = filterHeaders({ [name]: value }, 'response');
        expect(() => validateFrontierEvent('http/response', response({ headers })), name)
          .not.toThrow();
      }
    }
  });

  it('drops an authorization value even when its name is mixed-case', () => {
    expect(filterHeaders({ AUTHORIZATION: 'Bearer secret' }, 'request')).toEqual({});
  });
});

describe('http/request refusals', () => {
  it.each([
    'node', 'turn', 'uid', 'session', 'tool', 'model', 'provider', 'tokens', 'cost',
  ])('refuses the agnosticism-breaking key %s', (key) => {
    refusal(() => validateFrontierEvent('http/request', request({ [key]: 'x' })));
  });

  it('refuses an unknown key even when everything else is valid', () => {
    refusal(() => validateFrontierEvent('http/request', request({ stray: true })));
    expect(() => validateFrontierEvent('http/request', request({ stray: true })))
      .toThrow(/unexpected key "stray"/);
  });

  it.each([
    ['a separator', 'PO(ST'],
    ['a slash', 'PO/ST'],
    ['whitespace', 'PO ST'],
    ['a tab', 'PO\tST'],
    ['an empty token', ''],
  ])('refuses a method carrying %s', (_label, method) => {
    refusal(() => validateFrontierEvent('http/request', request({ method })));
  });

  it.each([['M-SEARCH'], ['GET'], ["!#$%&'*+-.^_`|~"]])(
    'accepts the RFC 7230 token %s',
    (method) => {
      expect(() => validateFrontierEvent('http/request', request({ method }))).not.toThrow();
    },
  );

  it.each([[{ 'content-type': 'application/json', authorization: 'Bearer secret' }],
    [{ 'set-cookie': 'session=1' }],
    [{ 'request-id': 'response-only' }],
    [{ 'x-api-key': 'secret' }]])(
    'refuses non-allowlisted request headers %j',
    (headers) => {
      refusal(() => validateFrontierEvent('http/request', request({ headers })));
    },
  );

  it('accepts a header value at the limit and refuses one code point over', () => {
    expect(() => validateFrontierEvent('http/request', request({
      headers: { 'content-type': 'x'.repeat(HEADER_VALUE_LIMIT) },
    }))).not.toThrow();
    refusal(() => validateFrontierEvent('http/request', request({
      headers: { 'content-type': 'x'.repeat(HEADER_VALUE_LIMIT + 1) },
    })));
  });

  it('refuses credentials with an empty id, an over-long id, too many entries or a bad placement', () => {
    const ok = { id: 'llm', where: 'authorization' };
    expect(() => validateFrontierEvent('http/request', request({
      credentials: Array.from({ length: FRONTIER_MAX_CREDENTIALS }, () => ok),
    }))).not.toThrow();
    refusal(() => validateFrontierEvent('http/request', request({
      credentials: Array.from({ length: FRONTIER_MAX_CREDENTIALS + 1 }, () => ok),
    })));
    refusal(() => validateFrontierEvent('http/request', request({
      credentials: [{ id: '', where: 'authorization' }],
    })));
    refusal(() => validateFrontierEvent('http/request', request({
      credentials: [{ id: 'i'.repeat(FRONTIER_MAX_CREDENTIAL_ID + 1), where: 'authorization' }],
    })));
    expect(() => validateFrontierEvent('http/request', request({
      credentials: [{ id: 'i'.repeat(FRONTIER_MAX_CREDENTIAL_ID), where: 'authorization' }],
    }))).not.toThrow();
    refusal(() => validateFrontierEvent('http/request', request({
      credentials: [{ id: 'llm', where: 'header' }],
    })));
  });

  it.each([[-1], [1.5], ['1']])('refuses attempt %j', (attempt) => {
    refusal(() => validateFrontierEvent('http/request', request({ attempt })));
  });

  it.each([[-1], [1.5], ['3']])('refuses body.bytes %j', (bytes) => {
    refusal(() => validateFrontierEvent('http/request', request({
      body: { ...(REQUEST['body'] as Record<string, unknown>), bytes },
    })));
  });

  it('refuses a request body that is not complete', () => {
    refusal(() => validateFrontierEvent('http/request', request({
      body: { ...(REQUEST['body'] as Record<string, unknown>), complete: false },
    })));
  });

  it('refuses an unknown body encoding or a malformed digest', () => {
    refusal(() => validateFrontierEvent('http/request', request({
      body: { ...(REQUEST['body'] as Record<string, unknown>), encoding: 'json' },
    })));
    refusal(() => validateFrontierEvent('http/request', request({
      body: { ...(REQUEST['body'] as Record<string, unknown>), sha256: 'A'.repeat(64) },
    })));
  });

  it.each([['abc'], ['a'.repeat(41)], ['A'.repeat(40)], ['b'.repeat(64) + '\n']])(
    'refuses world_head %j',
    (worldHead) => {
      refusal(() => validateFrontierEvent('http/request', request({ world_head: worldHead })));
    },
  );

  it('accepts a null world_head and a 64-hex world_head', () => {
    expect(() => validateFrontierEvent('http/request', request({ world_head: null }))).not.toThrow();
    expect(() => validateFrontierEvent('http/request', request({ world_head: 'b'.repeat(64) })))
      .not.toThrow();
  });
});

describe('http/response coherence', () => {
  it('accepts the coherent terminals', () => {
    expect(() => validateFrontierEvent('http/response', response({
      status: 200, error: null, complete: true,
    }))).not.toThrow();
    expect(() => validateFrontierEvent('http/response', response({
      status: 200, error: { code: 'cancelled' }, complete: false,
    }))).not.toThrow();
    expect(() => validateFrontierEvent('http/response', response({
      status: 302, error: { code: 'body-limit' }, complete: false,
    }))).not.toThrow();
    expect(() => validateFrontierEvent('http/response', response({
      status: 302, error: { code: 'http' }, complete: true,
    }))).not.toThrow();
    expect(() => validateFrontierEvent('http/response', response({
      status: 200, error: { code: 'timeout' }, complete: false,
    }))).not.toThrow();
    expect(() => validateFrontierEvent('http/response', response({
      status: null, error: { code: 'network' }, complete: false,
    }))).not.toThrow();
    expect(() => validateFrontierEvent('http/response', response({
      status: null, error: { code: 'local' }, complete: false,
    }))).not.toThrow();
  });

  it('refuses a null status with a missing or out-of-set error', () => {
    const missing = response({ status: null, complete: false });
    delete missing['error'];
    refusal(() => validateFrontierEvent('http/response', missing));
    refusal(() => validateFrontierEvent('http/response', response({
      status: null, error: null, complete: false,
    })));
    refusal(() => validateFrontierEvent('http/response', response({
      status: null, error: { code: 'http' }, complete: false,
    })));
    refusal(() => validateFrontierEvent('http/response', response({
      status: null, error: { code: 'body-limit' }, complete: false,
    })));
  });

  it("refuses error 'http' with a null or 200 status", () => {
    refusal(() => validateFrontierEvent('http/response', response({
      status: 200, error: { code: 'http' }, complete: true,
    })));
    refusal(() => validateFrontierEvent('http/response', response({
      status: null, error: { code: 'http' }, complete: false,
    })));
  });

  it('refuses a non-200 status with no error', () => {
    refusal(() => validateFrontierEvent('http/response', response({
      status: 302, error: null, complete: true,
    })));
  });

  it('refuses a 200 with no error and an incomplete body', () => {
    refusal(() => validateFrontierEvent('http/response', response({
      status: 200, error: null, complete: false,
    })));
  });

  it("refuses error 'body-limit' with a complete body", () => {
    refusal(() => validateFrontierEvent('http/response', response({
      status: 302, error: { code: 'body-limit' }, complete: true,
    })));
  });

  it.each(['network', 'timeout', 'cancelled', 'body-limit', 'local'])(
    'refuses a complete body with error %s',
    (code) => {
      refusal(() => validateFrontierEvent('http/response', response({
        status: code === 'local' ? null : 200, error: { code }, complete: true,
      })));
    },
  );

  it("refuses error 'local' with a known status", () => {
    refusal(() => validateFrontierEvent('http/response', response({
      status: 200, error: { code: 'local' }, complete: false,
    })));
  });

  it('refuses a null status with a complete body', () => {
    refusal(() => validateFrontierEvent('http/response', response({
      status: null, error: { code: 'network' }, complete: true,
    })));
  });

  it('refuses an unknown error code and an unknown key', () => {
    refusal(() => validateFrontierEvent('http/response', response({
      status: 200, error: { code: 'malformed' }, complete: true,
    })));
    refusal(() => validateFrontierEvent('http/response', { ...RESPONSE, node: 'n1' }));
  });

  it('refuses non-allowlisted response headers and an invalid duration', () => {
    refusal(() => validateFrontierEvent('http/response', response({
      headers: { 'set-cookie': 'session=1' },
    })));
    refusal(() => validateFrontierEvent('http/response', {
      ...RESPONSE, timing: { durationMs: -1 },
    }));
    refusal(() => validateFrontierEvent('http/response', {
      ...RESPONSE, timing: {},
    }));
  });
});

describe('the canonical-size backstop', () => {
  it('refuses an event whose canonical payload reaches CLAIM_CHECK_THRESHOLD', () => {
    // `method` is a valid RFC 7230 token longer than 16 KiB: the structural
    // checks pass and only the canonical-size backstop can refuse it.
    const method = 'A'.repeat(17 * 1024);
    expect(() => validateFrontierEvent('http/request', request({ method })))
      .toThrow(/canonical payload/);
    expect(() => validateFrontierEvent('http/request', request({ method })))
      .toThrow(FrontierValidationError);
    expect(Buffer.byteLength(method)).toBeGreaterThan(CLAIM_CHECK_THRESHOLD);
  });

  it('accepts a maximally-sized legitimate event, still under the threshold', () => {
    const base = 'https://example.com/';
    const url = base + 'a'.repeat(FRONTIER_MAX_URL_BYTES - base.length);
    expect(Buffer.byteLength(url, 'utf8')).toBe(FRONTIER_MAX_URL_BYTES);
    const control = '\u0001'.repeat(HEADER_VALUE_LIMIT);
    const event = request({
      url,
      headers: {
        'content-type': control, accept: control, 'anthropic-version': control,
      },
      credentials: Array.from({ length: FRONTIER_MAX_CREDENTIALS }, () => ({
        id: '\u0001'.repeat(FRONTIER_MAX_CREDENTIAL_ID), where: 'authorization',
      })),
    });
    expect(() => validateFrontierEvent('http/request', event)).not.toThrow();
    expect(Buffer.byteLength(canonicalizeJson(validateFrontierEvent('http/request', event))))
      .toBeLessThan(CLAIM_CHECK_THRESHOLD);
  });
});

describe('validateBeginInput', () => {
  function beginInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      method: 'POST',
      url: 'https://api.example.com/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([1, 2, 3]),
      encoding: 'utf8',
      ...overrides,
    };
  }

  it('defaults attempt to 0 and credentials to none, and omits an absent group', () => {
    const out = validateBeginInput(beginInput());
    expect(out.attempt).toBe(0);
    expect(out.credentials).toEqual([]);
    expect('group' in out).toBe(false);
    expect(out.method).toBe('POST');
    expect(out.url).toBe('https://api.example.com/v1/messages');
  });

  it('keeps a supplied group and attempt', () => {
    const out = validateBeginInput(beginInput({ group: GROUP, attempt: 2 }));
    expect(out.group).toBe(GROUP);
    expect(out.attempt).toBe(2);
  });

  it.each(['node', 'turn', 'uid', 'session', 'world_head', 'model'])(
    'refuses the unknown key %s',
    (key) => {
      const input = beginInput({ [key]: 'x' });
      expect(() => validateBeginInput(input)).toThrow(FrontierValidationError);
      if (key === 'world_head') expect(() => validateBeginInput(input))
        .toThrow(/unexpected key "world_head"/);
    },
  );

  it('refuses attempt > 0 with no group', () => {
    expect(() => validateBeginInput(beginInput({ attempt: 1 })))
      .toThrow(/attempt > 0/);
    refusal(() => validateBeginInput(beginInput({ attempt: 1 })));
    expect(() => validateBeginInput(beginInput({ group: GROUP, attempt: 1 }))).not.toThrow();
  });

  it.each([[-1], [1.5], ['0']])('refuses attempt %j', (attempt) => {
    refusal(() => validateBeginInput(beginInput({ attempt })));
  });

  it('refuses a URL the frontier predicate refuses', () => {
    refusal(() => validateBeginInput(beginInput({ url: 'https://api.example.com/v1?key=1' })));
  });

  it('refuses an unfiltered header name or an over-limit value', () => {
    refusal(() => validateBeginInput(beginInput({ headers: { Authorization: 'Bearer x' } })));
    refusal(() => validateBeginInput(beginInput({
      headers: { 'content-type': 'x'.repeat(HEADER_VALUE_LIMIT + 1) },
    })));
  });

  it('refuses a non-token method and a body that is not bytes', () => {
    refusal(() => validateBeginInput(beginInput({ method: 'PO ST' })));
    refusal(() => validateBeginInput(beginInput({ body: 'not bytes' })));
    refusal(() => validateBeginInput(beginInput({ encoding: 'json' })));
  });

  it('refuses credentials beyond the bounds and a non-authorization placement', () => {
    refusal(() => validateBeginInput(beginInput({
      credentials: Array.from({ length: FRONTIER_MAX_CREDENTIALS + 1 }, () => ({
        id: 'llm', where: 'authorization',
      })),
    })));
    refusal(() => validateBeginInput(beginInput({
      credentials: [{ id: 'llm', where: 'header' }],
    })));
  });
});

describe('validateOutcome', () => {
  function outcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { status: 200, body: new Uint8Array(), encoding: 'binary', complete: true, ...overrides };
  }

  it('defaults headers to empty and omits an absent error', () => {
    const out = validateOutcome(outcome());
    expect(out.headers).toEqual({});
    expect('error' in out).toBe(false);
    expect(out.status).toBe(200);
    expect(out.complete).toBe(true);
  });

  it('keeps filtered response headers and a supplied error code', () => {
    const out = validateOutcome(outcome({
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
      status: 302,
      complete: false,
      error: 'http',
    }));
    expect(out.headers).toEqual({ 'content-type': 'application/json', 'retry-after': '30' });
    expect(out.error).toBe('http');
  });

  it('applies the same coherence table', () => {
    refusal(() => validateOutcome(outcome({ status: null })));
    refusal(() => validateOutcome(outcome({ status: null, complete: false })));
    refusal(() => validateOutcome(outcome({
      status: 200, complete: false, error: null,
    })));
    refusal(() => validateOutcome(outcome({
      status: 200, complete: true, error: 'http',
    })));
    refusal(() => validateOutcome(outcome({
      status: 302, complete: true,
    })));
    refusal(() => validateOutcome(outcome({
      status: 200, complete: true, error: 'body-limit',
    })));
    refusal(() => validateOutcome(outcome({
      status: 200, complete: false, error: 'local',
    })));
    refusal(() => validateOutcome(outcome({
      status: null, complete: true, error: 'network',
    })));
  });

  it('accepts the legitimate in-stream failures with a known status', () => {
    expect(() => validateOutcome(outcome({
      status: 200, complete: false, error: 'cancelled',
    }))).not.toThrow();
    expect(() => validateOutcome(outcome({
      status: 302, complete: false, error: 'body-limit',
    }))).not.toThrow();
  });

  it('refuses an unknown key, an unfiltered header and an unknown error code', () => {
    refusal(() => validateOutcome(outcome({ node: 'n1' })));
    refusal(() => validateOutcome(outcome({ headers: { 'set-cookie': 's=1' } })));
    refusal(() => validateOutcome(outcome({
      status: 302, complete: false, error: 'malformed',
    })));
  });
});
