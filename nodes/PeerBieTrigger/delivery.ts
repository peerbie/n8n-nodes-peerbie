import type { IDataObject } from 'n8n-workflow';

import {
	DELIVERY_HEADER,
	EVENT_HEADER,
	SIGNATURE_HEADER,
	TIMESTAMP_HEADER,
	verifySignature,
} from '../PeerBie/shared/signature';

export interface HookStaticData {
	hookId?: string;
	secret?: string;
}

export interface DeliveryInput {
	staticData: HookStaticData;
	headers: Record<string, string | string[] | undefined>;
	rawBody: Buffer | string | undefined;
	body: unknown;
	/** The event this trigger listens to. */
	event: string;
	now?: number;
}

export type DeliveryDecision =
	| { action: 'emit'; payload: IDataObject }
	| { action: 'ignore'; status: 200; reason: string }
	| { action: 'reject'; status: 401 | 410; reason: string };

function header(headers: DeliveryInput['headers'], name: string): string | undefined {
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
	}
	return undefined;
}

/**
 * What to do with one POST from PeerBie:
 * - 410 Gone when this trigger holds no hook (PeerBie then deletes the subscription);
 * - 401 when the signature or timestamp is not valid (nothing is emitted);
 * - 200 without emitting for a delivery of another hook or event;
 * - otherwise emit the payload.
 */
export function decideDelivery(input: DeliveryInput): DeliveryDecision {
	const { staticData, headers } = input;
	if (!staticData.hookId || !staticData.secret) {
		return { action: 'reject', status: 410, reason: 'no_subscription' };
	}
	const check = verifySignature({
		secret: staticData.secret,
		timestamp: header(headers, TIMESTAMP_HEADER),
		signature: header(headers, SIGNATURE_HEADER),
		rawBody: input.rawBody,
		now: input.now,
	});
	if (!check.valid) {
		return { action: 'reject', status: 401, reason: check.reason };
	}

	let payload: unknown = input.body;
	if (payload === undefined || payload === null || typeof payload !== 'object') {
		try {
			payload = JSON.parse(
				Buffer.isBuffer(input.rawBody) ? input.rawBody.toString('utf8') : String(input.rawBody),
			);
		} catch {
			return { action: 'ignore', status: 200, reason: 'not_json' };
		}
	}
	const data = payload as IDataObject;

	if (data.subscription_id && String(data.subscription_id) !== staticData.hookId) {
		return { action: 'ignore', status: 200, reason: 'other_subscription' };
	}
	const event = header(headers, EVENT_HEADER) ?? (data.event as string | undefined);
	if (event && event !== input.event) {
		return { action: 'ignore', status: 200, reason: 'other_event' };
	}
	const deliveryId = header(headers, DELIVERY_HEADER);
	if (deliveryId && !data.id) data.id = deliveryId;
	return { action: 'emit', payload: data };
}
