import { NodeApiError } from 'n8n-workflow';

import {
	buildRequestOptions,
	mapPeerBieError,
	normalizeBaseUrl,
	parseRetryAfter,
	peerBieApiRequest,
	peerBieApiRequestAllItems,
	timing,
} from '../nodes/PeerBie/shared/transport';
import { fakeContext } from './helpers';

const call = <T>(fn: (...args: never[]) => T, ctx: unknown, ...args: unknown[]): T =>
	(fn as unknown as (...a: unknown[]) => T).call(ctx, ...args);

describe('request building', () => {
	it('normalises the base URL', () => {
		expect(normalizeBaseUrl(undefined)).toBe('https://api.peerbie.com/api/public/v1');
		expect(normalizeBaseUrl('  ')).toBe('https://api.peerbie.com/api/public/v1');
		expect(normalizeBaseUrl('https://x.test/api/public/v1///')).toBe('https://x.test/api/public/v1');
	});

	it('builds a JSON request with the full URL, clean query and body', () => {
		const options = buildRequestOptions(
			'https://api.peerbie.com/api/public/v1/',
			'POST',
			'/workflows/w1/runs',
			{ data: { amount: 3 } },
			{ stage: '', since: undefined, limit: 10, offset: 0 },
		);
		expect(options).toMatchObject({
			method: 'POST',
			url: 'https://api.peerbie.com/api/public/v1/workflows/w1/runs',
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			body: { data: { amount: 3 } },
			qs: { limit: 10, offset: 0 },
		});
	});

	it('leaves out an empty query and body', () => {
		const options = buildRequestOptions('https://h/v1', 'GET', 'me');
		expect(options.url).toBe('https://h/v1/me');
		expect(options.qs).toBeUndefined();
		expect(options.body).toBeUndefined();
	});
});

describe('Retry-After', () => {
	it('reads seconds and HTTP dates', () => {
		expect(parseRetryAfter('17')).toBe(17);
		expect(parseRetryAfter(undefined)).toBeUndefined();
		expect(parseRetryAfter('soon')).toBeUndefined();
		const now = Date.parse('2026-10-28T10:00:00Z');
		expect(parseRetryAfter('Wed, 28 Oct 2026 10:00:30 GMT', now)).toBe(30);
	});
});

describe('error mapping', () => {
	it.each([
		[401, 'invalid_key', 'The API key is not valid.'],
		[401, 'key_revoked', 'Revoked.'],
		[401, 'key_expired', 'Expired.'],
		[401, 'key_owner_gone', 'Gone.'],
		[403, 'insufficient_scope', 'This API key needs the scope: workflows:start.'],
		[404, 'not_found', 'Workflow not found.'],
		[400, 'bad_request', 'since must be an ISO 8601 time.'],
		[400, 'invalid_url', 'target_url must be https.'],
		[400, 'too_many_hooks', 'Delete one first.'],
		[409, 'paused', 'Starts are paused.'],
		[429, 'rate_limited', 'Too many requests for this API key.'],
	])('maps %i %s', (status, code, message) => {
		const info = mapPeerBieError(status, { error: { code, message } });
		expect(info.code).toBe(code);
		expect(info.httpCode).toBe(String(status));
		expect(info.message).toBe(`PeerBie: ${message}`);
		expect(info.description).toContain(`Error code: ${code}`);
	});

	it('falls back on the status when the body is not PeerBie JSON', () => {
		expect(mapPeerBieError(502, '<html>Bad gateway</html>')).toMatchObject({
			code: 'error',
			message: 'PeerBie: request failed with status 502',
		});
		expect(mapPeerBieError(403, undefined).code).toBe('insufficient_scope');
		expect(mapPeerBieError(409, '{"error":{"code":"paused","message":"Paused."}}')).toMatchObject({
			code: 'paused',
			message: 'PeerBie: Paused.',
		});
	});
});

describe('peerBieApiRequest', () => {
	const sleep = jest.fn(async () => undefined);
	beforeEach(() => {
		sleep.mockClear();
		timing.sleep = sleep;
	});

	it('returns the JSON body and uses the credential base URL', async () => {
		const ctx = fakeContext([{ statusCode: 200, body: { workspace: { id: 'n1' } } }], {
			baseUrl: 'https://staging.test/api/public/v1/',
		});
		const out = await call(peerBieApiRequest, ctx, 'GET', '/me');
		expect(out).toEqual({ workspace: { id: 'n1' } });
		expect(ctx.calls[0].url).toBe('https://staging.test/api/public/v1/me');
		expect(ctx.helpers.httpRequestWithAuthentication.mock.calls[0][0]).toBe('peerBieApi');
	});

	it('returns {} for 204 No Content', async () => {
		const ctx = fakeContext([{ statusCode: 204, body: '' }]);
		expect(await call(peerBieApiRequest, ctx, 'DELETE', '/hooks/h1')).toEqual({});
	});

	it('throws NodeApiError with the PeerBie code and HTTP status', async () => {
		const ctx = fakeContext([
			{ statusCode: 409, body: { error: { code: 'paused', message: 'Starts are paused.' } } },
		]);
		const err = await call(peerBieApiRequest, ctx, 'POST', '/workflows/w/runs', { data: {} }).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(NodeApiError);
		expect((err as NodeApiError).httpCode).toBe('409');
		expect((err as NodeApiError).message).toBe('PeerBie: Starts are paused.');
		expect((err as NodeApiError).description).toContain('paused');
	});

	it('waits for Retry-After on 429 and retries', async () => {
		const ctx = fakeContext([
			{
				statusCode: 429,
				headers: { 'Retry-After': '2' },
				body: { error: { code: 'rate_limited', message: 'Too many.' } },
			},
			{ statusCode: 200, body: { ok: true } },
		]);
		expect(await call(peerBieApiRequest, ctx, 'GET', '/workflows')).toEqual({ ok: true });
		expect(sleep).toHaveBeenCalledWith(2000);
		expect(ctx.calls).toHaveLength(2);
	});

	it('does not wait for a long Retry-After; it reports it', async () => {
		const ctx = fakeContext([
			{
				statusCode: 429,
				headers: { 'retry-after': '3600' },
				body: { error: { code: 'rate_limited', message: 'Too many.' } },
			},
		]);
		const err = (await call(peerBieApiRequest, ctx, 'GET', '/workflows').catch(
			(e: unknown) => e,
		)) as NodeApiError;
		expect(sleep).not.toHaveBeenCalled();
		expect(err.httpCode).toBe('429');
		expect(err.description).toContain('Retry after 3600 seconds');
	});

	it('gives up after 3 rate-limit retries', async () => {
		const limited = {
			statusCode: 429,
			headers: { 'retry-after': '1' },
			body: { error: { code: 'rate_limited', message: 'Too many.' } },
		};
		const ctx = fakeContext([limited, limited, limited, limited]);
		const err = (await call(peerBieApiRequest, ctx, 'GET', '/me').catch(
			(e: unknown) => e,
		)) as NodeApiError;
		expect(err.httpCode).toBe('429');
		expect(sleep).toHaveBeenCalledTimes(3);
		expect(ctx.calls).toHaveLength(4);
	});

	it('wraps a network failure in NodeApiError', async () => {
		const ctx = fakeContext([new Error('ECONNREFUSED')]);
		await expect(call(peerBieApiRequest, ctx, 'GET', '/me')).rejects.toBeInstanceOf(NodeApiError);
	});
});

describe('pagination', () => {
	const page = (ids: number[], hasMore: boolean, next: number | null) => ({
		statusCode: 200,
		body: { results: ids.map((id) => ({ id })), has_more: hasMore, next_offset: next },
	});

	it('follows next_offset until has_more is false (Return All)', async () => {
		const first = Array.from({ length: 100 }, (_, i) => i);
		const second = Array.from({ length: 30 }, (_, i) => 100 + i);
		const ctx = fakeContext([page(first, true, 100), page(second, false, null)]);
		const rows = await call(peerBieApiRequestAllItems, ctx, '/workflows/w/items', {
			stage: 's1',
		});
		expect(rows).toHaveLength(130);
		expect(ctx.calls.map((c) => c.qs)).toEqual([
			{ stage: 's1', limit: 100, offset: 0 },
			{ stage: 's1', limit: 100, offset: 100 },
		]);
	});

	it('asks only for what the limit needs', async () => {
		const ctx = fakeContext([page([1, 2, 3, 4, 5], true, 5)]);
		const rows = await call(peerBieApiRequestAllItems, ctx, '/workflows', {}, 5);
		expect(rows).toHaveLength(5);
		expect(ctx.calls).toHaveLength(1);
		expect(ctx.calls[0].qs).toEqual({ limit: 5, offset: 0 });
	});

	it('spans pages for a limit above 100', async () => {
		const first = Array.from({ length: 100 }, (_, i) => i);
		const ctx = fakeContext([page(first, true, 100), page([100, 101, 102], true, 103)]);
		const rows = await call(peerBieApiRequestAllItems, ctx, '/workflows', {}, 103);
		expect(rows).toHaveLength(103);
		expect(ctx.calls[1].qs).toEqual({ limit: 3, offset: 100 });
	});

	it('stops on a page without a usable next_offset', async () => {
		const ctx = fakeContext([page([1], true, null)]);
		expect(await call(peerBieApiRequestAllItems, ctx, '/workflows')).toHaveLength(1);
	});
});
