import { createHmac } from 'crypto';

import { computeSignature, verifySignature } from '../nodes/PeerBie/shared/signature';
import { decideDelivery } from '../nodes/PeerBieTrigger/delivery';

// Produced by the backend's own algorithm (manageable_apps/stage_webhook.sign) in Python:
// json.dumps(payload, ensure_ascii=False) and HMAC-SHA256(secret, "<ts>.<body>").
const PY_BODY =
	'{"id": "d1", "event": "item.created", "subscription_id": "h1", "item": {"fields": {"name": "Şükrü ✓", "amount": 7}}}';
const PY_TS = '1761667200';
const PY_SECRET = 'whsec_test';
const PY_SIGNATURE = 'sha256=d118e6689f161120d0b502abef7acb82c80ae09e04632e1d14a2b80ad188efea';
const PY_NOW = Number(PY_TS) * 1000;

describe('computeSignature', () => {
	it('matches the signature the PeerBie backend computes (non-ASCII body)', () => {
		expect(computeSignature(PY_SECRET, PY_TS, Buffer.from(PY_BODY, 'utf8'))).toBe(PY_SIGNATURE);
		expect(computeSignature(PY_SECRET, PY_TS, PY_BODY)).toBe(PY_SIGNATURE);
	});

	it('is sha256=<hex HMAC(secret, "ts.body")>', () => {
		const expected =
			'sha256=' + createHmac('sha256', 's').update('12.{"a":1}').digest('hex');
		expect(computeSignature('s', '12', '{"a":1}')).toBe(expected);
	});
});

describe('verifySignature', () => {
	const base = {
		secret: PY_SECRET,
		timestamp: PY_TS,
		signature: PY_SIGNATURE,
		rawBody: Buffer.from(PY_BODY, 'utf8'),
		now: PY_NOW,
	};

	it('accepts a valid delivery', () => {
		expect(verifySignature(base)).toEqual({ valid: true });
	});

	it('accepts a delivery 299 seconds old', () => {
		expect(verifySignature({ ...base, now: PY_NOW + 299_000 })).toEqual({ valid: true });
	});

	it('rejects a delivery older than 5 minutes', () => {
		expect(verifySignature({ ...base, now: PY_NOW + 301_000 })).toEqual({
			valid: false,
			reason: 'stale_timestamp',
		});
	});

	it('rejects a timestamp too far in the future', () => {
		expect(verifySignature({ ...base, now: PY_NOW - 301_000 })).toEqual({
			valid: false,
			reason: 'stale_timestamp',
		});
	});

	it('rejects a wrong secret', () => {
		expect(verifySignature({ ...base, secret: 'whsec_other' })).toEqual({
			valid: false,
			reason: 'bad_signature',
		});
	});

	it('rejects a tampered body', () => {
		expect(verifySignature({ ...base, rawBody: PY_BODY.replace('7', '8') })).toEqual({
			valid: false,
			reason: 'bad_signature',
		});
	});

	it('rejects a re-serialised body (signature is over the raw bytes)', () => {
		const reserialised = JSON.stringify(JSON.parse(PY_BODY));
		expect(verifySignature({ ...base, rawBody: reserialised }).valid).toBe(false);
	});

	it('rejects a signature of a different length or format', () => {
		expect(verifySignature({ ...base, signature: 'sha256=abc' }).valid).toBe(false);
		expect(verifySignature({ ...base, signature: PY_SIGNATURE.replace('sha256=', '') }).valid).toBe(
			false,
		);
	});

	it('rejects missing pieces', () => {
		expect(verifySignature({ ...base, secret: undefined })).toEqual({
			valid: false,
			reason: 'missing_secret',
		});
		expect(verifySignature({ ...base, timestamp: undefined })).toEqual({
			valid: false,
			reason: 'missing_headers',
		});
		expect(verifySignature({ ...base, signature: undefined })).toEqual({
			valid: false,
			reason: 'missing_headers',
		});
		expect(verifySignature({ ...base, rawBody: undefined })).toEqual({
			valid: false,
			reason: 'missing_body',
		});
		expect(verifySignature({ ...base, timestamp: '17x' })).toEqual({
			valid: false,
			reason: 'bad_timestamp',
		});
	});
});

describe('decideDelivery (trigger webhook)', () => {
	const headers = {
		'x-peerbie-timestamp': PY_TS,
		'x-peerbie-signature': PY_SIGNATURE,
		'x-peerbie-event': 'item.created',
		'x-peerbie-delivery': 'd1',
	};
	const staticData = { hookId: 'h1', secret: PY_SECRET };
	const rawBody = Buffer.from(PY_BODY, 'utf8');

	it('emits a valid delivery', () => {
		const out = decideDelivery({
			staticData,
			headers,
			rawBody,
			body: JSON.parse(PY_BODY),
			event: 'item.created',
			now: PY_NOW,
		});
		expect(out.action).toBe('emit');
		if (out.action === 'emit') expect(out.payload.subscription_id).toBe('h1');
	});

	it('parses the raw body when n8n did not parse it', () => {
		const out = decideDelivery({
			staticData,
			headers,
			rawBody,
			body: undefined,
			event: 'item.created',
			now: PY_NOW,
		});
		expect(out.action).toBe('emit');
	});

	it('answers 401 and emits nothing for a bad signature', () => {
		const out = decideDelivery({
			staticData,
			headers: { ...headers, 'x-peerbie-signature': 'sha256=' + '0'.repeat(64) },
			rawBody,
			body: JSON.parse(PY_BODY),
			event: 'item.created',
			now: PY_NOW,
		});
		expect(out).toEqual({ action: 'reject', status: 401, reason: 'bad_signature' });
	});

	it('answers 401 for a replay older than 5 minutes', () => {
		const out = decideDelivery({
			staticData,
			headers,
			rawBody,
			body: JSON.parse(PY_BODY),
			event: 'item.created',
			now: PY_NOW + 10 * 60_000,
		});
		expect(out).toEqual({ action: 'reject', status: 401, reason: 'stale_timestamp' });
	});

	it('answers 410 Gone when this trigger holds no hook (PeerBie then deletes it)', () => {
		const out = decideDelivery({
			staticData: {},
			headers,
			rawBody,
			body: JSON.parse(PY_BODY),
			event: 'item.created',
			now: PY_NOW,
		});
		expect(out).toEqual({ action: 'reject', status: 410, reason: 'no_subscription' });
	});

	it('ignores a delivery for another event', () => {
		const out = decideDelivery({
			staticData,
			headers,
			rawBody,
			body: JSON.parse(PY_BODY),
			event: 'item.entered_stage',
			now: PY_NOW,
		});
		expect(out).toEqual({ action: 'ignore', status: 200, reason: 'other_event' });
	});
});
