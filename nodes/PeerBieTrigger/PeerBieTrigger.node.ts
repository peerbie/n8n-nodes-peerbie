import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';

import { workflowLocator } from '../PeerBie/shared/descriptions';
import { getStages, searchWorkflows } from '../PeerBie/shared/methods';
import { peerBieApiRequest } from '../PeerBie/shared/transport';
import type { HookStaticData } from './delivery';
import { decideDelivery } from './delivery';

function isNotFound(error: unknown): boolean {
	const e = error as { httpCode?: string; context?: IDataObject };
	return String(e?.httpCode ?? '') === '404';
}

export class PeerBieTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PeerBie Trigger',
		name: 'peerBieTrigger',
		icon: { light: 'file:../../icons/peerbie.svg', dark: 'file:../../icons/peerbie.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow when an item is created in a PeerBie workflow or enters a stage',
		defaults: { name: 'PeerBie Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'peerBieApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				required: true,
				default: 'item.created',
				options: [
					{
						name: 'Item Created',
						value: 'item.created',
						description: 'A new item was created in the workflow (form, public form, API or trigger)',
					},
					{
						name: 'Item Entered Stage',
						value: 'item.entered_stage',
						description: 'An item arrived in a stage (and stayed there)',
					},
				],
			},
			workflowLocator,
			{
				displayName: 'Stage Name or ID',
				name: 'stageId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getStages',
					loadOptionsDependsOn: ['workflowId.value'],
				},
				default: '',
				description:
					'Only this stage. Leave empty for every stage. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { event: ['item.entered_stage'] } },
			},
			{
				displayName:
					'PeerBie delivers only to public https:// addresses, and every delivery is checked against its signature before the workflow runs',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	methods = {
		listSearch: { searchWorkflows },
		loadOptions: { getStages },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node') as HookStaticData;
				if (!staticData.hookId || !staticData.secret) return false;
				const webhookUrl = this.getNodeWebhookUrl('default');
				const event = this.getNodeParameter('event') as string;
				const workflowId = String(
					this.getNodeParameter('workflowId', '', { extractValue: true }),
				).trim();
				const stageId =
					event === 'item.entered_stage' ? (this.getNodeParameter('stageId', '') as string) : '';
				try {
					const hook = await peerBieApiRequest.call(
						this,
						'GET',
						`/hooks/${encodeURIComponent(staticData.hookId)}`,
					);
					const same =
						hook.active !== false &&
						hook.target_url === webhookUrl &&
						hook.event === event &&
						String(hook.workflow_id) === workflowId &&
						String(hook.stage_id || '') === String(stageId || '');
					if (same) return true;
					// Settings changed: remove the old hook so create() makes a fresh one.
					await peerBieApiRequest
						.call(this, 'DELETE', `/hooks/${encodeURIComponent(staticData.hookId)}`)
						.catch(() => undefined);
				} catch (error) {
					if (!isNotFound(error)) {
						const nodeError =
							error instanceof NodeApiError
								? error
								: new NodeApiError(this.getNode(), error as JsonObject);
						throw nodeError;
					}
				}
				delete staticData.hookId;
				delete staticData.secret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node') as HookStaticData;
				const event = this.getNodeParameter('event') as string;
				const workflowId = String(
					this.getNodeParameter('workflowId', '', { extractValue: true }),
				).trim();
				const body: IDataObject = {
					target_url: this.getNodeWebhookUrl('default'),
					event,
					workflow_id: workflowId,
				};
				if (event === 'item.entered_stage') {
					const stageId = this.getNodeParameter('stageId', '') as string;
					if (stageId) body.stage_id = stageId;
				}
				const hook = await peerBieApiRequest.call(this, 'POST', '/hooks', body);
				if (!hook.id || !hook.secret) {
					throw new NodeApiError(this.getNode(), hook as JsonObject, {
						message: 'PeerBie did not return a hook id and secret',
					});
				}
				staticData.hookId = String(hook.id);
				staticData.secret = String(hook.secret);
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node') as HookStaticData;
				if (staticData.hookId) {
					try {
						await peerBieApiRequest.call(
							this,
							'DELETE',
							`/hooks/${encodeURIComponent(staticData.hookId)}`,
						);
					} catch (error) {
						// 404: PeerBie already removed it (410 answer, or turned off after failures).
						if (!isNotFound(error)) return false;
					}
				}
				delete staticData.hookId;
				delete staticData.secret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject() as unknown as {
			headers: Record<string, string | string[] | undefined>;
			body: unknown;
			rawBody?: Buffer;
		};
		const decision = decideDelivery({
			staticData: this.getWorkflowStaticData('node') as HookStaticData,
			headers: req.headers,
			rawBody: req.rawBody,
			body: req.body,
			event: this.getNodeParameter('event') as string,
		});

		if (decision.action === 'emit') {
			return { workflowData: [this.helpers.returnJsonArray(decision.payload)] };
		}
		const res = this.getResponseObject();
		res.status(decision.status).json({ ok: decision.action === 'ignore', reason: decision.reason });
		return { noWebhookResponse: true };
	}
}
