import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

export const CREDENTIAL_NAME = 'peerBieApi';
export const DEFAULT_BASE_URL = 'https://api.peerbie.com/api/public/v1';

/** The API answers at most this many rows per page. */
export const MAX_PAGE_SIZE = 100;

/** How often a 429 is retried, and the longest Retry-After we are willing to wait. */
export const MAX_RATE_LIMIT_RETRIES = 3;
export const MAX_RETRY_AFTER_SECONDS = 60;

export type PeerBieContext =
	| IExecuteFunctions
	| IHookFunctions
	| ILoadOptionsFunctions
	| IWebhookFunctions;

/** Swappable in tests. */
export const timing = { sleep };

interface FullResponse {
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

/** Explanations for every error code the PeerBie public API returns. */
const ERROR_HINTS: Record<string, string> = {
	unauthenticated: 'No API key was sent. Check the PeerBie credential.',
	invalid_key: 'The API key is not valid. Check that it was copied completely.',
	key_revoked: 'This API key was revoked in PeerBie. Create a new key and update the credential.',
	key_expired: 'This API key has expired. Create a new key and update the credential.',
	key_owner_gone:
		'The admin who created this API key is no longer an admin of the workspace, so the key stopped working. Ask a current admin to create a new key.',
	insufficient_scope:
		'The API key does not have the scope this operation needs. Create a key with the right scopes (see the node documentation).',
	not_found: 'It does not exist in the workspace of this API key, or it is not a live workflow.',
	bad_request: 'PeerBie could not accept the request as sent.',
	invalid_url:
		'PeerBie only delivers to public https:// addresses. Use a public n8n URL (set WEBHOOK_URL on self-hosted n8n).',
	not_accepted: 'The workflow did not accept this run.',
	too_many_hooks: 'Too many hooks exist for this key, workflow or workspace. Delete unused ones first.',
	paused: 'Starts of this workflow are paused in PeerBie. Resume the workflow and try again.',
	rate_limited: 'Too many requests for this API key (60 a minute, 10,000 a day). Try again later.',
	method_not_allowed: 'This request method is not supported on this path.',
};

export function normalizeBaseUrl(raw: unknown): string {
	const text = typeof raw === 'string' ? raw.trim() : '';
	return (text || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function headerValue(headers: FullResponse['headers'] | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
	}
	return undefined;
}

/** Seconds to wait from a Retry-After header (seconds or an HTTP date); undefined when absent. */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | undefined {
	if (value === undefined || value === null) return undefined;
	const text = String(value).trim();
	if (!text) return undefined;
	if (/^\d+$/.test(text)) return parseInt(text, 10);
	const at = Date.parse(text);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, Math.ceil((at - now) / 1000));
}

export interface PeerBieErrorInfo {
	code: string;
	message: string;
	description: string;
	httpCode: string;
}

/** {"error": {"code", "message"}} (or anything else) → what the user sees. */
export function mapPeerBieError(statusCode: number, body: unknown): PeerBieErrorInfo {
	let parsed = body;
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			parsed = undefined;
		}
	}
	const error =
		parsed && typeof parsed === 'object' && 'error' in parsed
			? ((parsed as IDataObject).error as IDataObject | undefined)
			: undefined;
	const code =
		(error && typeof error.code === 'string' && error.code) ||
		(statusCode === 401
			? 'invalid_key'
			: statusCode === 403
				? 'insufficient_scope'
				: statusCode === 404
					? 'not_found'
					: statusCode === 409
						? 'paused'
						: statusCode === 429
							? 'rate_limited'
							: 'error');
	const serverMessage = error && typeof error.message === 'string' ? error.message : '';
	const hint = ERROR_HINTS[code] ?? '';
	return {
		code,
		message: `PeerBie: ${serverMessage || hint || `request failed with status ${statusCode}`}`,
		description: [hint && hint !== serverMessage ? hint : '', `Error code: ${code}`]
			.filter(Boolean)
			.join(' '),
		httpCode: String(statusCode),
	};
}

export function buildRequestOptions(
	baseUrl: string,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): IHttpRequestOptions {
	const cleanQs: IDataObject = {};
	for (const [key, value] of Object.entries(qs ?? {})) {
		if (value !== undefined && value !== null && value !== '') cleanQs[key] = value;
	}
	const options: IHttpRequestOptions = {
		method,
		url: `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`,
		headers: { Accept: 'application/json' },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (Object.keys(cleanQs).length) options.qs = cleanQs;
	if (body !== undefined) options.body = body;
	return options;
}

/**
 * One call to the PeerBie public API. Returns the parsed JSON body (an empty
 * object for 204). Throws NodeApiError with the PeerBie error code for any
 * non-2xx answer; waits and retries on 429 when Retry-After is short.
 */
export async function peerBieApiRequest(
	this: PeerBieContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	const options = buildRequestOptions(
		normalizeBaseUrl(credentials.baseUrl),
		method,
		path,
		body,
		qs,
	);

	for (let attempt = 0; ; attempt++) {
		let response: FullResponse;
		try {
			response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				CREDENTIAL_NAME,
				options,
			)) as FullResponse;
		} catch (error) {
			throw new NodeApiError(this.getNode(), error as JsonObject, {
				message: 'PeerBie could not be reached',
			});
		}

		const status = Number(response.statusCode);
		if (status >= 200 && status < 300) {
			const data = response.body;
			return data && typeof data === 'object' ? (data as IDataObject) : {};
		}

		if (status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
			const wait = parseRetryAfter(headerValue(response.headers, 'retry-after'));
			if (wait !== undefined && wait <= MAX_RETRY_AFTER_SECONDS) {
				await timing.sleep(Math.max(1, wait) * 1000);
				continue;
			}
		}

		const info = mapPeerBieError(status, response.body);
		const retryAfter = headerValue(response.headers, 'retry-after');
		throw new NodeApiError(
			this.getNode(),
			{ code: info.code, message: info.message, httpCode: info.httpCode } as JsonObject,
			{
				message: info.message,
				description:
					status === 429 && retryAfter
						? `${info.description} Retry after ${retryAfter} seconds.`
						: info.description,
				httpCode: info.httpCode,
			},
		);
	}
}

/**
 * Every row of a paginated list ({results, has_more, next_offset}), following
 * offset pagination. ``maxResults`` stops early (undefined = all).
 */
export async function peerBieApiRequestAllItems(
	this: PeerBieContext,
	path: string,
	qs: IDataObject = {},
	maxResults?: number,
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	let offset = 0;
	for (;;) {
		const remaining = maxResults === undefined ? MAX_PAGE_SIZE : maxResults - rows.length;
		if (remaining <= 0) break;
		const limit = Math.min(MAX_PAGE_SIZE, remaining);
		const page = await peerBieApiRequest.call(this, 'GET', path, undefined, {
			...qs,
			limit,
			offset,
		});
		const results = Array.isArray(page.results) ? (page.results as IDataObject[]) : [];
		rows.push(...results);
		const next = page.next_offset;
		if (!page.has_more || typeof next !== 'number' || next <= offset || results.length === 0) break;
		offset = next;
	}
	return maxResults === undefined ? rows : rows.slice(0, maxResults);
}
