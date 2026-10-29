import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class PeerBieApi implements ICredentialType {
	name = 'peerBieApi';

	displayName = 'PeerBie API';

	icon: Icon = { light: 'file:../icons/peerbie.svg', dark: 'file:../icons/peerbie.dark.svg' };

	documentationUrl = 'https://github.com/peerbie/n8n-nodes-peerbie#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'pb_live_…',
			description:
				'A workspace API key. Create one in PeerBie under Settings → Basic → API keys. It is shown only once.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.peerbie.com/api/public/v1',
			description: 'Only change this if PeerBie support asked you to',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{($credentials.baseUrl || "https://api.peerbie.com/api/public/v1").replace(/\\/+$/, "")}}',
			url: '/me',
			method: 'GET',
		},
	};
}
