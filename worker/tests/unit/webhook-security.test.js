/**
 * SSRF hardening for webhooks: URL validation, DNS pinning, delivery limits.
 */

// Jest requires mock variables to be prefixed with "mock"
const mockLookup = jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
const mockFetch = jest.fn();
const mockQuery = jest.fn(async () => ({ rows: [{ id: 'wh-1' }], rowCount: 1 }));
const mockAgentOptions = [];

jest.mock('dns', () => ({ promises: { lookup: mockLookup } }));

jest.mock('undici', () => ({
  fetch: mockFetch,
  Agent: jest.fn(function MockAgent(options) {
    mockAgentOptions.push(options);
    this.options = options;
    this.close = jest.fn(async () => {});
  }),
}));

jest.mock('../../src/db', () => ({ query: mockQuery, pool: { query: mockQuery } }));

const {
  validateWebhookUrl,
  isPublicIp,
  resolveAndValidate,
  createPinnedDispatcher,
} = require('../../src/utils/urlGuard');

const {
  deliverWithRetry,
  readCappedBody,
  validateEvents,
  WEBHOOK_EVENTS,
  MAX_RESPONSE_BYTES,
} = require('../../src/services/webhookService');

// ── Helpers ──────────────────────────────────────────────

function makeResponse(status, chunks) {
  const state = { reads: 0, cancelled: false };
  const response = {
    status,
    ok: status >= 200 && status < 300,
    body: {
      getReader: () => ({
        async read() {
          if (state.reads >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[state.reads++] };
        },
        async cancel() {
          state.cancelled = true;
        },
      }),
    },
    _state: state,
  };
  return response;
}

function lastDeliveryLog() {
  const call = [...mockQuery.mock.calls]
    .reverse()
    .find(([text]) => text.includes('INSERT INTO webhook_deliveries'));
  if (!call) return null;
  const [, params] = call;
  return {
    attempt: params[3],
    statusCode: params[4],
    responseBody: params[5],
    error: params[7],
    delivered: params[8],
    nextRetryAt: params[9],
  };
}

const webhook = {
  id: 'wh-1',
  url: 'https://example.com/hook',
  secret: 'whsec_test',
};

beforeEach(() => {
  mockQuery.mockClear();
  mockFetch.mockReset();
  mockLookup.mockClear();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mockAgentOptions.length = 0;
});

// ── validateWebhookUrl ───────────────────────────────────

describe('validateWebhookUrl', () => {
  it('should accept a public https URL', () => {
    const parsed = validateWebhookUrl('https://example.com/hook');
    expect(parsed.hostname).toBe('example.com');
  });

  it('should accept a public http URL on an allowed port', () => {
    expect(() => validateWebhookUrl('http://example.com:8443/hook')).not.toThrow();
  });

  it('should accept a public IP literal', () => {
    expect(() => validateWebhookUrl('https://93.184.216.34/hook')).not.toThrow();
  });

  const rejected = [
    ['loopback IPv4', 'http://127.0.0.1/'],
    ['localhost by name', 'http://localhost:3000/'],
    ['localhost subdomain', 'http://api.localhost/hook'],
    ['.local mDNS name', 'http://printer.local/hook'],
    ['.internal name', 'http://metadata.internal/hook'],
    ['RFC1918 10/8', 'http://10.0.0.5/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['RFC1918 172.16/12', 'http://172.20.10.4/'],
    ['link-local metadata', 'http://169.254.169.254/latest/meta-data'],
    ['CGNAT 100.64/10', 'http://100.64.1.1/'],
    ['this-network 0/8', 'http://0.0.0.0/'],
    ['broadcast', 'http://255.255.255.255/'],
    ['multicast', 'http://224.0.0.1/'],
    ['benchmark 198.18/15', 'http://198.18.0.1/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 unspecified', 'http://[::]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv6 unique-local', 'http://[fc00::1]/'],
    ['IPv6 multicast', 'http://[ff02::1]/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped IPv6 hex form', 'http://[::ffff:7f00:1]/'],
    ['NAT64 prefix', 'http://[64:ff9b::7f00:1]/'],
    ['hex integer host', 'http://0x7f000001/'],
    ['decimal integer host', 'http://2130706433/'],
    ['octal integer host', 'http://017700000001/'],
    ['short-form IPv4', 'http://127.1/'],
    ['ftp scheme', 'ftp://example.com/'],
    ['file scheme', 'file:///etc/passwd'],
    ['gopher scheme', 'gopher://example.com/'],
    ['credentials in URL', 'http://user:pass@example.com/'],
    ['disallowed port', 'http://example.com:22/'],
    ['disallowed port 6379', 'http://example.com:6379/'],
    ['not a URL', 'not-a-url'],
    ['empty', ''],
  ];

  it.each(rejected)('should reject %s', (_label, url) => {
    let thrown = null;
    try {
      validateWebhookUrl(url);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.status).toBe(400);
    expect(thrown.code).toBe('INVALID_WEBHOOK_URL');
  });
});

// ── isPublicIp ───────────────────────────────────────────

describe('isPublicIp', () => {
  it('should accept public addresses', () => {
    expect(isPublicIp('93.184.216.34')).toBe(true);
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
  });

  it('should reject reserved IPv4 ranges', () => {
    const reserved = [
      '0.1.2.3', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.168.0.1',
      '198.19.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
    ];
    for (const ip of reserved) expect(isPublicIp(ip)).toBe(false);
  });

  it('should reject reserved IPv6 ranges', () => {
    const reserved = ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '64:ff9b::1'];
    for (const ip of reserved) expect(isPublicIp(ip)).toBe(false);
  });

  it('should re-check the embedded v4 of IPv4-mapped addresses', () => {
    expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIp('::ffff:169.254.169.254')).toBe(false);
    expect(isPublicIp('::ffff:7f00:1')).toBe(false);
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
  });

  it('should reject non-IP input', () => {
    expect(isPublicIp('example.com')).toBe(false);
    expect(isPublicIp(undefined)).toBe(false);
  });
});

// ── resolveAndValidate ───────────────────────────────────

describe('resolveAndValidate', () => {
  it('should return resolved addresses for a public host', async () => {
    const addresses = await resolveAndValidate('example.com');
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(mockLookup).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
  });

  it('should block a host that resolves to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(resolveAndValidate('evil.example.com')).rejects.toMatchObject({
      code: 'BLOCKED_ADDRESS',
    });
  });

  it('should block when ANY resolved address is private', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(resolveAndValidate('mixed.example.com')).rejects.toMatchObject({
      code: 'BLOCKED_ADDRESS',
    });
  });

  it('should report DNS failure separately from a blocked address', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(resolveAndValidate('missing.example.com')).rejects.toMatchObject({
      code: 'DNS_FAILED',
    });
  });
});

// ── createPinnedDispatcher ───────────────────────────────

describe('createPinnedDispatcher', () => {
  it('should pin the connect lookup to the validated addresses', (done) => {
    createPinnedDispatcher([{ address: '93.184.216.34', family: 4 }]);
    const { lookup } = mockAgentOptions[0].connect;

    lookup('attacker-rebound.example.com', {}, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
      done();
    });
  });

  it('should support the all:true lookup form', (done) => {
    createPinnedDispatcher([{ address: '93.184.216.34', family: 4 }]);
    const { lookup } = mockAgentOptions[0].connect;

    lookup('example.com', { all: true }, (err, results) => {
      expect(err).toBeNull();
      expect(results).toEqual([{ address: '93.184.216.34', family: 4 }]);
      done();
    });
  });

  it('should refuse to pin a non-public address', () => {
    expect(() => createPinnedDispatcher([{ address: '127.0.0.1', family: 4 }]))
      .toThrow(/non-public/);
  });

  it('should refuse an empty address list', () => {
    expect(() => createPinnedDispatcher([])).toThrow();
  });
});

// ── Event validation ─────────────────────────────────────

describe('validateEvents', () => {
  it('should accept known events', () => {
    expect(validateEvents(['file.uploaded', 'file.deleted'])).toEqual(['file.uploaded', 'file.deleted']);
    expect(WEBHOOK_EVENTS).toContain('file.processed');
  });

  it('should reject unknown events', () => {
    let thrown = null;
    try {
      validateEvents(['file.uploaded', 'file.exfiltrated']);
    } catch (err) {
      thrown = err;
    }
    expect(thrown.status).toBe(400);
    expect(thrown.code).toBe('INVALID_WEBHOOK_EVENTS');
  });

  it('should reject duplicates', () => {
    expect(() => validateEvents(['file.uploaded', 'file.uploaded']))
      .toThrow(/Duplicate/);
  });

  it('should reject an empty or non-array value', () => {
    expect(() => validateEvents([])).toThrow(/non-empty array/);
    expect(() => validateEvents('file.uploaded')).toThrow(/non-empty array/);
  });
});

// ── Response body cap ────────────────────────────────────

describe('readCappedBody', () => {
  it('should stop reading past the cap and cancel the stream', async () => {
    const chunks = new Array(10).fill(null).map(() => Buffer.alloc(1000, 'a'));
    const response = makeResponse(200, chunks);

    const body = await readCappedBody(response);

    expect(body.length).toBe(MAX_RESPONSE_BYTES);
    expect(response._state.reads).toBeLessThan(chunks.length);
    expect(response._state.cancelled).toBe(true);
  });

  it('should return short bodies intact', async () => {
    const response = makeResponse(200, [Buffer.from('ok')]);
    expect(await readCappedBody(response)).toBe('ok');
  });
});

// ── deliverWithRetry ─────────────────────────────────────

describe('deliverWithRetry', () => {
  it('should deliver via a pinned dispatcher with redirects disabled', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, [Buffer.from('ok')]));

    await deliverWithRetry(webhook, 'file.uploaded', { id: 'f1' }, 'proj-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(options.redirect).toBe('manual');
    expect(options.dispatcher).toBeDefined();
    expect(options.headers['X-MV-Signature']).toBeDefined();

    const log = lastDeliveryLog();
    expect(log.delivered).toBe(true);
    expect(log.statusCode).toBe(200);
    expect(log.nextRetryAt).toBeNull();
  });

  it('should truncate the stored response body to the cap', async () => {
    const chunks = new Array(10).fill(null).map(() => Buffer.alloc(1000, 'a'));
    mockFetch.mockResolvedValue(makeResponse(200, chunks));

    await deliverWithRetry(webhook, 'file.uploaded', { id: 'f1' }, 'proj-1');

    expect(lastDeliveryLog().responseBody.length).toBe(MAX_RESPONSE_BYTES);
  });

  it('should treat a 3xx as a failure without following it', async () => {
    mockFetch.mockResolvedValue(makeResponse(302, [Buffer.from('')]));

    await deliverWithRetry(webhook, 'file.uploaded', { id: 'f1' }, 'proj-1');

    const log = lastDeliveryLog();
    expect(log.delivered).toBe(false);
    expect(log.statusCode).toBe(302);
    expect(log.error).toMatch(/redirect not followed/);
  });

  it('should block delivery to a private address and not retry', async () => {
    const blocked = { ...webhook, url: 'http://169.254.169.254/latest/meta-data' };

    await deliverWithRetry(blocked, 'file.uploaded', { id: 'f1' }, 'proj-1');

    expect(mockFetch).not.toHaveBeenCalled();
    const log = lastDeliveryLog();
    expect(log.delivered).toBe(false);
    expect(log.error).toBe('blocked: non-public address');
    expect(log.nextRetryAt).toBeNull();
  });

  it('should block delivery when DNS rebinds to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

    await deliverWithRetry(webhook, 'file.uploaded', { id: 'f1' }, 'proj-1');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(lastDeliveryLog().error).toBe('blocked: non-public address');
  });

  it('should schedule a retry for a transient failure', async () => {
    mockFetch.mockRejectedValue(new Error('socket hang up'));

    await deliverWithRetry(webhook, 'file.uploaded', { id: 'f1' }, 'proj-1');

    const log = lastDeliveryLog();
    expect(log.delivered).toBe(false);
    expect(log.error).toBe('socket hang up');
    expect(log.nextRetryAt).toBeInstanceOf(Date);
  });
});
