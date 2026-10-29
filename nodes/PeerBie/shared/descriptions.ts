import type { INodeProperties } from 'n8n-workflow';

/** The workflow to act on: picked from a list, or pasted as an ID. */
export const workflowLocator: INodeProperties = {
	displayName: 'Workflow',
	name: 'workflowId',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'A live workflow of the workspace the API key belongs to',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: {
				searchListMethod: 'searchWorkflows',
				searchable: true,
			},
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. 6f1c2a7e-1b2c-4d5e-8f90-123456789abc',
		},
	],
};
