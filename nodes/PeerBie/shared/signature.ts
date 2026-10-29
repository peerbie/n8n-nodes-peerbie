import { createHmac, timingSafeEqual } from 'crypto';

/** Deliveries older (or further in the future) than this are refused. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const SIGNATURE_HEADER = 'x-peerbie-signature';
export const TIMESTAMP_HEADER = 'x-peerbie-timestamp';
export const EVENT_HEADER = 'x-peerbie-event';
export const DELIVERY_HEADER = 'x-peerbie-delivery';

/**
 * PeerBie signs each hook delivery as
 *   X-PeerBie-Timestamp: <unix seconds>
 *   X-PeerBie-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 */
export function computeSignature(secret: string, timestamp: string, rawBody: Buffer | string): string {
	const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
	const mac = createHmac('sha256', secret);
	mac.update(`${timestamp}.`, 'utf8');
	mac.update(body);
	return `sha256=${mac.digest('hex')}`;
}

export type SignatureCheck =
	| { valid: true }
	| {
			valid: false;
			reason:
				| 'missing_secret'
				| 'missing_headers'
				| 'missing_body'
				| 'bad_timestamp'
				| 'stale_timestamp'
				| 'bad_signature';
	  };

export interface SignatureInput {
	secret: string | undefined;
	timestamp: string | undefined;
	signature: string | undefined;
	rawBody: Buffer | string | undefined;
	/** Current time in milliseconds (injectable for tests). */
	now?: number;
	toleranceSeconds?: number;
}

export function verifySignature(input: SignatureInput): SignatureCheck {
	const { secret, timestamp, signature, rawBody } = input;
	if (!secret) return { valid: false, reason: 'missing_secret' };
	if (!timestamp || !signature) return { valid: false, reason: 'missing_headers' };
	if (rawBody === undefined || rawBody === null) return { valid: false, reason: 'missing_body' };
	if (!/^\d{1,12}$/.test(timestamp.trim())) return { valid: false, reason: 'bad_timestamp' };

	const now = input.now ?? Date.now();
	const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
	const age = Math.floor(now / 1000) - parseInt(timestamp.trim(), 10);
	if (Math.abs(age) > tolerance) return { valid: false, reason: 'stale_timestamp' };

	const expected = Buffer.from(computeSignature(secret, timestamp.trim(), rawBody), 'utf8');
	const received = Buffer.from(signature.trim(), 'utf8');
	if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
		return { valid: false, reason: 'bad_signature' };
	}
	return { valid: true };
}
