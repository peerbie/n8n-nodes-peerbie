// Live smoke test without any key: GET /me must answer 401 with the PeerBie error shape.
// Run: npm run smoke
const base = 'https://api.peerbie.com/api/public/v1';
const cases = [
	{ name: 'no key', headers: {}, code: 'unauthenticated' },
	{ name: 'malformed key', headers: { Authorization: 'Bearer pb_live_invalid' }, code: 'invalid_key' },
];
let failed = 0;
for (const c of cases) {
	const res = await fetch(`${base}/me`, { headers: c.headers });
	const body = await res.json().catch(() => ({}));
	const ok = res.status === 401 && body?.error?.code === c.code;
	console.log(`${ok ? 'PASS' : 'FAIL'} GET /me (${c.name}) -> ${res.status} ${JSON.stringify(body)}`);
	if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
