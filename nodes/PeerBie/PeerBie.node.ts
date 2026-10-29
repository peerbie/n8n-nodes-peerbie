import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { workflowLocator } from './shared/descriptions';
import { cleanRunData, getStages, getWorkflowFields, searchWorkflows } from './shared/methods';
import { peerBieApiRequest, peerBieApiRequestAllItems } from './shared/transport';

export class PeerBie implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PeerBie',
		name: 'peerBie',
		icon: { light: 'file:../../icons/peerbie.svg', dark: 'file:../../icons/peerbie.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Start PeerBie workflow runs and read workflows and items',
		defaults: { name: 'PeerBie' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'peerBieApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Item', value: 'item' },
					{ name: 'Run', value: 'run' },
					{ name: 'Workflow', value: 'workflow' },
				],
				default: 'run',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['workflow'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						description: 'Get a workflow with its fields and stages',
						action: 'Get a workflow',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List the live workflows of the workspace',
						action: 'Get many workflows',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['run'] } },
				options: [
					{
						name: 'Start',
						value: 'start',
						description: 'Start a workflow run with field values',
						action: 'Start a workflow run',
					},
				],
				default: 'start',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['item'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List the items of a workflow, newest first',
						action: 'Get many items',
					},
				],
				default: 'getAll',
			},
			{
				...workflowLocator,
				displayOptions: { show: { resource: ['workflow'], operation: ['get'] } },
			},
			{
				...workflowLocator,
				displayOptions: { show: { resource: ['run', 'item'] } },
			},
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				required: true,
				typeOptions: {
					loadOptionsDependsOn: ['workflowId.value'],
					resourceMapper: {
						resourceMapperMethod: 'getWorkflowFields',
						mode: 'add',
						fieldWords: { singular: 'field', plural: 'fields' },
						addAllFields: true,
						multiKeyMatch: false,
						supportAutoMap: true,
					},
				},
				displayOptions: { show: { resource: ['run'], operation: ['start'] } },
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				description: 'Whether to return all results or only up to a given limit',
				displayOptions: { show: { resource: ['workflow', 'item'], operation: ['getAll'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: {
					show: { resource: ['workflow', 'item'], operation: ['getAll'], returnAll: [false] },
				},
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['item'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Archived',
						name: 'archived',
						type: 'boolean',
						default: false,
						description: 'Whether to return archived items instead of active ones',
					},
					{
						displayName: 'Created After',
						name: 'since',
						type: 'dateTime',
						default: '',
						description: 'Only items created after this time',
					},
					{
						displayName: 'Stage Name or ID',
						name: 'stage',
						type: 'options',
						typeOptions: {
							loadOptionsMethod: 'getStages',
							loadOptionsDependsOn: ['workflowId.value'],
						},
						default: '',
						description:
							'Only items currently in this stage. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
				],
			},
		],
	};

	methods = {
		listSearch: { searchWorkflows },
		loadOptions: { getStages },
		resourceMapping: { getWorkflowFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let result: IDataObject | IDataObject[] = {};

				if (resource === 'workflow' && operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const limit = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);
					result = await peerBieApiRequestAllItems.call(this, '/workflows', {}, limit);
				} else {
					const workflowId = String(
						this.getNodeParameter('workflowId', i, '', { extractValue: true }),
					).trim();
					const base = `/workflows/${encodeURIComponent(workflowId)}`;

					if (resource === 'workflow' && operation === 'get') {
						result = await peerBieApiRequest.call(this, 'GET', base);
					} else if (resource === 'run' && operation === 'start') {
						const fields = this.getNodeParameter('fields', i) as { value: IDataObject | null };
						result = await peerBieApiRequest.call(this, 'POST', `${base}/runs`, {
							data: cleanRunData(fields?.value),
						});
					} else if (resource === 'item' && operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const limit = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);
						const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
						const qs: IDataObject = {};
						if (filters.stage) qs.stage = filters.stage;
						if (filters.since) qs.since = new Date(filters.since as string).toISOString();
						if (filters.archived) qs.archived = 'true';
						result = await peerBieApiRequestAllItems.call(this, `${base}/items`, qs, limit);
					}
				}

				const rows = Array.isArray(result) ? result : [result];
				for (const row of rows) {
					returnData.push({ json: row, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				throw nodeError;
			}
		}

		return [returnData];
	}
}
