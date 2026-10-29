import { PeerBieApi } from '../credentials/PeerBieApi.credentials';
import { cleanRunData, toResourceMapperFields } from '../nodes/PeerBie/shared/methods';
import { timing } from '../nodes/PeerBie/shared/transport';
import { PeerBieTrigger } from '../nodes/PeerBieTrigger/PeerBieTrigger.node';
import { fakeContext } from './helpers';

const hooks = new PeerBieTrigger().webhookMethods.default;
const run = <T>(fn: (...args: never[]) => T, ctx: unknown): T =>
	(fn as unknown as () => T).call(ctx);

beforeAll(() => {
	timing.sleep = async () => undefined;
});

describe('credential', () => {
	const cred = new PeerBieApi();
	it('sends the key as a Bearer token and tests GET /me', () => {
		expect(cred.authenticate.properties.headers).toEqual({
			Authorization: '=Bearer {{$credentials.apiKey}}',
		});
		expect(cred.test.request.url).toBe('/me');
		expect(cred.properties.find((p) => p.name === 'apiKey')?.typeOptions?.password).toBe(true);
		expect(cred.properties.find((p) => p.name === 'baseUrl')?.default).toBe(
			'https://api.peerbie.com/api/public/v1',
		);
	});
});

describe('run fields', () => {
	it('maps PeerBie field types to resource-mapper inputs', () => {
		const fields = toResourceMapperFields([
			{ name: 'amount', label: 'Amount', type: 'number', required: true },
			{ name: 'due', label: 'Due', type: 'date' },
			{ name: 'tier', label: 'Tier', type: 'single_select', options: ['VIP', 'Basic'] },
			{ name: 'tags', label: 'Tags', type: 'multi_select', options: ['a', 'b'] },
			{ name: 'email', type: 'email' },
		]);
		expect(fields.map((f) => [f.id, f.type, f.required])).toEqual([
			['amount', 'number', true],
			['due', 'dateTime', false],
			['tier', 'options', false],
			['tags', 'string', false],
			['email', 'string', false],
		]);
		expect(fields[2].options).toEqual([
			{ name: 'VIP', value: 'VIP' },
			{ name: 'Basic', value: 'Basic' },
		]);
		expect(fields[3].displayName).toBe('Tags (comma-separated)');
		expect(fields[4].displayName).toBe('email');
	});

	it('sends only the fields that have a value', () => {
		expect(cleanRunData({ a: 1, b: '', c: null, d: false, e: 0 })).toEqual({ a: 1, d: false, e: 0 });
		expect(cleanRunData(null)).toEqual({});
	});
});

describe('trigger webhook lifecycle', () => {
	const params = {
		event: 'item.entered_stage',
		workflowId: { __rl: true, mode: 'list', value: 'w1' },
		stageId: 's2',
	};

	it('create() subscribes with the webhook URL and stores id + secret', async () => {
		const ctx = fakeContext(
			[{ statusCode: 201, body: { id: 'h1', secret: 'whsec_abc', event: 'item.entered_stage' } }],
			{ params },
		);
		expect(await run(hooks.create, ctx)).toBe(true);
		expect(ctx.calls[0]).toMatchObject({
			method: 'POST',
			url: 'https://api.peerbie.com/api/public/v1/hooks',
			body: {
				target_url: 'https://n8n.example.com/webhook/abc/webhook',
				event: 'item.entered_stage',
				workflow_id: 'w1',
				stage_id: 's2',
			},
		});
		expect(ctx.staticData).toEqual({ hookId: 'h1', secret: 'whsec_abc' });
	});

	it('create() sends no stage for item.created', async () => {
		const ctx = fakeContext([{ statusCode: 201, body: { id: 'h1', secret: 'whsec_abc' } }], {
			params: { ...params, event: 'item.created' },
		});
		await run(hooks.create, ctx);
		expect(ctx.calls[0].body).not.toHaveProperty('stage_id');
	});

	it('checkExists() is true for the same live hook', async () => {
		const ctx = fakeContext(
			[
				{
					statusCode: 200,
					body: {
						id: 'h1',
						active: true,
						event: 'item.entered_stage',
						workflow_id: 'w1',
						stage_id: 's2',
						target_url: 'https://n8n.example.com/webhook/abc/webhook',
					},
				},
			],
			{ params, staticData: { hookId: 'h1', secret: 'whsec_abc' } },
		);
		expect(await run(hooks.checkExists, ctx)).toBe(true);
		expect(ctx.calls[0].url).toBe('https://api.peerbie.com/api/public/v1/hooks/h1');
	});

	it('checkExists() forgets a hook PeerBie removed (404)', async () => {
		const ctx = fakeContext(
			[{ statusCode: 404, body: { error: { code: 'not_found', message: 'Hook not found.' } } }],
			{ params, staticData: { hookId: 'h1', secret: 'whsec_abc' } },
		);
		expect(await run(hooks.checkExists, ctx)).toBe(false);
		expect(ctx.staticData).toEqual({});
	});

	it('checkExists() replaces a hook whose settings changed', async () => {
		const ctx = fakeContext(
			[
				{
					statusCode: 200,
					body: { id: 'h1', active: true, event: 'item.created', workflow_id: 'w1', target_url: 'x' },
				},
				{ statusCode: 204 },
			],
			{ params, staticData: { hookId: 'h1', secret: 'whsec_abc' } },
		);
		expect(await run(hooks.checkExists, ctx)).toBe(false);
		expect(ctx.calls[1].method).toBe('DELETE');
		expect(ctx.staticData).toEqual({});
	});

	it('checkExists() is false without stored data and calls nothing', async () => {
		const ctx = fakeContext([], { params });
		expect(await run(hooks.checkExists, ctx)).toBe(false);
		expect(ctx.calls).toHaveLength(0);
	});

	it('checkExists() surfaces other errors (e.g. a revoked key)', async () => {
		const ctx = fakeContext(
			[{ statusCode: 401, body: { error: { code: 'key_revoked', message: 'Revoked.' } } }],
			{ params, staticData: { hookId: 'h1', secret: 'whsec_abc' } },
		);
		await expect(run(hooks.checkExists, ctx)).rejects.toMatchObject({ httpCode: '401' });
	});

	it('delete() unsubscribes on deactivation and clears the stored secret', async () => {
		const ctx = fakeContext([{ statusCode: 204 }], {
			params,
			staticData: { hookId: 'h1', secret: 'whsec_abc' },
		});
		expect(await run(hooks.delete, ctx)).toBe(true);
		expect(ctx.calls[0]).toMatchObject({
			method: 'DELETE',
			url: 'https://api.peerbie.com/api/public/v1/hooks/h1',
		});
		expect(ctx.staticData).toEqual({});
	});

	it('delete() accepts a hook already gone (404)', async () => {
		const ctx = fakeContext(
			[{ statusCode: 404, body: { error: { code: 'not_found', message: 'Hook not found.' } } }],
			{ params, staticData: { hookId: 'h1', secret: 'whsec_abc' } },
		);
		expect(await run(hooks.delete, ctx)).toBe(true);
		expect(ctx.staticData).toEqual({});
	});
});
