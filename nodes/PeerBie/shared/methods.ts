import type {
	FieldType,
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { peerBieApiRequest, peerBieApiRequestAllItems } from './transport';

export interface PeerBieField {
	name: string;
	label?: string;
	type?: string;
	required?: boolean;
	options?: string[];
}

/** PeerBie field type → the n8n input shown in the resource mapper. */
export function fieldTypeFor(type: string | undefined, hasOptions: boolean): FieldType {
	switch (type) {
		case 'number':
			return 'number';
		case 'date':
			return 'dateTime';
		case 'single_select':
			return hasOptions ? 'options' : 'string';
		case 'checkbox':
		case 'boolean':
			return 'boolean';
		default:
			// text, multi_line_text, email, user, attachment, multi_select (comma-separated) …
			return 'string';
	}
}

export function toResourceMapperFields(fields: PeerBieField[]): ResourceMapperField[] {
	return fields
		.filter((field) => field && typeof field.name === 'string' && field.name)
		.map((field) => {
			const options = Array.isArray(field.options) ? field.options.filter((o) => o !== '') : [];
			const type = fieldTypeFor(field.type, options.length > 0);
			const label = field.label || field.name;
			const hint = field.type === 'multi_select' ? ' (comma-separated)' : '';
			const mapped: ResourceMapperField = {
				id: field.name,
				displayName: `${label}${hint}`,
				required: Boolean(field.required),
				defaultMatch: false,
				canBeUsedToMatch: false,
				display: true,
				type,
			};
			if (type === 'options') {
				mapped.options = options.map((option) => ({ name: option, value: option }));
			}
			return mapped;
		});
}

/** The values of a resource mapper parameter, without the fields left empty. */
export function cleanRunData(values: IDataObject | null | undefined): IDataObject {
	const data: IDataObject = {};
	for (const [key, value] of Object.entries(values ?? {})) {
		if (value === undefined || value === null || value === '') continue;
		data[key] = value;
	}
	return data;
}

function currentWorkflowId(this: ILoadOptionsFunctions): string {
	const value = this.getCurrentNodeParameter('workflowId', { extractValue: true });
	return typeof value === 'string' ? value.trim() : '';
}

export async function searchWorkflows(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const workflows = await peerBieApiRequestAllItems.call(this, '/workflows');
	const needle = (filter ?? '').trim().toLowerCase();
	return {
		results: workflows
			.filter((wf) => !needle || String(wf.name ?? '').toLowerCase().includes(needle))
			.map((wf) => ({ name: String(wf.name || wf.id), value: String(wf.id) })),
	};
}

export async function getStages(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const workflowId = currentWorkflowId.call(this);
	if (!workflowId) return [];
	const workflow = await peerBieApiRequest.call(
		this,
		'GET',
		`/workflows/${encodeURIComponent(workflowId)}`,
	);
	const stages = Array.isArray(workflow.stages) ? (workflow.stages as IDataObject[]) : [];
	return stages.map((stage) => ({
		name: String(stage.name || stage.id),
		value: String(stage.id),
	}));
}

export async function getWorkflowFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const workflowId = currentWorkflowId.call(this);
	if (!workflowId) {
		throw new NodeOperationError(this.getNode(), 'Choose a workflow first');
	}
	const workflow = await peerBieApiRequest.call(
		this,
		'GET',
		`/workflows/${encodeURIComponent(workflowId)}`,
	);
	const fields = Array.isArray(workflow.fields) ? (workflow.fields as unknown as PeerBieField[]) : [];
	return { fields: toResourceMapperFields(fields) };
}
