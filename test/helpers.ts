import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';

export interface FakeResponse {
	statusCode: number;
	body?: unknown;
	headers?: Record<string, string>;
}

/** A minimal n8n function context: credentials, node and a scripted HTTP helper. */
export function fakeContext(
	responses: Array<FakeResponse | Error>,
	options: {
		baseUrl?: string;
		params?: IDataObject;
		staticData?: IDataObject;
		webhookUrl?: string;
	} = {},
) {
	const calls: IHttpRequestOptions[] = [];
	const queue = [...responses];
	const staticData = options.staticData ?? {};
	const ctx = {
		calls,
		staticData,
		getCredentials: jest.fn(async () => ({
			apiKey: 'pb_live_abcdefgh_' + 'x'.repeat(40),
			baseUrl: options.baseUrl ?? 'https://api.peerbie.com/api/public/v1/',
		})),
		getNode: jest.fn(() => ({
			id: 'n1',
			name: 'PeerBie',
			type: 'n8n-nodes-peerbie.peerBie',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		})),
		getNodeParameter: jest.fn((name: string, fallback?: unknown) => {
			const value = options.params?.[name];
			if (value && typeof value === 'object' && '__rl' in (value as IDataObject)) {
				return (value as IDataObject).value;
			}
			return value === undefined ? fallback : value;
		}),
		getWorkflowStaticData: jest.fn(() => staticData),
		getNodeWebhookUrl: jest.fn(() => options.webhookUrl ?? 'https://n8n.example.com/webhook/abc/webhook'),
		helpers: {
			httpRequestWithAuthentication: jest.fn(async (_cred: string, req: IHttpRequestOptions) => {
				calls.push(req);
				const next = queue.shift();
				if (!next) throw new Error('no scripted response left');
				if (next instanceof Error) throw next;
				return { statusCode: next.statusCode, body: next.body, headers: next.headers ?? {} };
			}),
		},
	};
	return ctx;
}
