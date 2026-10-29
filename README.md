# n8n-nodes-peerbie

This is an n8n community node package. It lets you use [PeerBie](https://peerbie.com) workflows in your n8n workflows: start a run, read workflows and their items, and start an n8n workflow when an item is created or enters a stage.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

- [Installation](#installation)
- [Credentials](#credentials)
- [Operations](#operations)
- [Trigger](#trigger)
- [Signature verification](#signature-verification)
- [Compatibility](#compatibility)
- [Limits and errors](#limits-and-errors)
- [Development](#development)
- [Resources](#resources)

## Installation

In n8n, open **Settings → Community Nodes → Install**, enter `n8n-nodes-peerbie` and confirm.

See the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) for self-hosted and queue-mode setups.

## Credentials

The nodes use a **PeerBie workspace API key** (`pb_live_…`).

1. In PeerBie, as a workspace **admin**, open **Settings → Basic → API keys**.
2. Create a key, give it a name (for example "n8n") and tick the scopes you need (table below).
3. Copy the key. It is shown **only once**.
4. In n8n, create a **PeerBie API** credential and paste the key. Leave **Base URL** at `https://api.peerbie.com/api/public/v1`.

n8n tests the credential with `GET /me`.

| Operation | Scope needed |
|---|---|
| Workflow → Get / Get Many | `workflows:read` |
| Run → Start | `workflows:start` (and `workflows:read` to pick the workflow and load its fields) |
| Item → Get Many | `items:read` (and `workflows:read` for the workflow and stage lists) |
| PeerBie Trigger | `hooks:manage` + `items:read` (and `workflows:read` for the lists) |

A key stops working when it is revoked, when it expires, or when the admin who created it is no longer an admin of the workspace. Everything a key sees is limited to its own workspace.

## Operations

### PeerBie node

| Resource | Operation | What it does |
|---|---|---|
| Workflow | Get Many | Lists the workspace's live workflows (id, name, stages, created/updated time). Return All or a Limit. |
| Workflow | Get | One workflow with its **fields** (name, label, type, required, options) and **stages**. |
| Run | Start | Starts a run of the chosen workflow, as if its form had been filled in. The workflow's fields are loaded from PeerBie and shown as inputs by type (number, date, dropdown for single-select, text for the rest; multi-select takes comma-separated values). Empty fields are not sent. Returns the new item's `id`, `stage`, `url`. |
| Item | Get Many | The items of a workflow, newest first. Filters: **Stage**, **Created After**, **Archived**. Return All pages through the results (100 per request). |

The workflow can be picked **from a list** or given **by ID**.

The node can be used as a tool by an n8n AI Agent.

## Trigger

**PeerBie Trigger** starts your n8n workflow on:

- **Item Created** (`item.created`): a new item was created in the chosen workflow (form, public form, API or trigger start).
- **Item Entered Stage** (`item.entered_stage`): an item arrived in a stage and stayed there. Optionally limit it to one **stage**.

When you activate the n8n workflow (or listen for a test event), the node subscribes a hook in PeerBie (`POST /hooks`) and stores the hook's id and signing secret in the workflow's static data. When you deactivate it, the hook is deleted (`DELETE /hooks/{id}`). If the settings change, the old hook is replaced.

The output is the delivery as PeerBie sends it:

```json
{
  "id": "delivery uuid (use it to de-duplicate)",
  "event": "item.created",
  "occurred_at": "2026-10-28T09:00:00Z",
  "subscription_id": "hook uuid",
  "workflow": { "id": "…", "name": "Hiring" },
  "stage": { "id": "…", "name": "Screening" },
  "item": { "id": "…", "workflow_id": "…", "stage": { "id": "…", "name": "…" }, "fields": { "amount": 7 }, "values": { "Amount": 7 }, "url": "https://mywork.peerbie.com/…", "archived": false, "created_at": "…", "updated_at": "…" }
}
```

`fields` are keyed by the field's internal name, `values` by its label.

**Your n8n must be reachable at a public `https://` address.** PeerBie refuses private, local and plain-http addresses. On self-hosted n8n set `WEBHOOK_URL` to your public URL. "Listen for test event" on an n8n running on localhost cannot receive PeerBie events.

Delivery notes (from PeerBie's side): a delivery must be answered within 3 seconds (n8n answers immediately); failed deliveries are retried 3 times; after 3 failed deliveries in a row the hook is turned off (deactivate and activate the n8n workflow to subscribe again); event order is not guaranteed.

## Signature verification

Every delivery is signed with the hook's own secret:

```
X-PeerBie-Timestamp: <unix seconds>
X-PeerBie-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw request body>")>
X-PeerBie-Event:     item.created | item.entered_stage
X-PeerBie-Delivery:  <delivery id>
```

Before anything is emitted, the trigger checks the signature over the **raw** body (constant-time comparison) and refuses a timestamp more than **5 minutes** old or in the future. An invalid delivery gets `401` and does not run the workflow. A delivery arriving at a trigger that holds no hook gets `410 Gone`, which tells PeerBie to delete that subscription.

## Compatibility

- Built with `@n8n/node-cli` 0.54 against `n8n-workflow` 2.45 (n8n 2.x).
- Tested with n8n 2.45 (which itself runs on Node.js 24 or newer). Older n8n versions with resource mapper and `NodeConnectionTypes` support should work but are untested.
- Node.js 22 for developing this package (see `.nvmrc`).
- Optional date fields: leave them untouched when you have no value. An expression that produces an empty string makes n8n itself refuse to run the node.

## Limits and errors

- 60 requests a minute and 10,000 a day per API key. On `429` the node waits for `Retry-After` (up to 60 seconds, 3 times) and then fails with the wait time.
- Errors carry PeerBie's code: `unauthenticated`, `invalid_key`, `key_revoked`, `key_expired`, `key_owner_gone` (401); `insufficient_scope` (403); `not_found` (404); `bad_request`, `invalid_url`, `not_accepted`, `too_many_hooks` (400); `paused` (409, the workflow's starts are paused); `rate_limited` (429).
- At most 50 hooks per key, 20 per workflow, 100 per workspace.

## Development

```bash
nvm use            # Node 22
npm install
npm run build      # n8n-node build (TypeScript + icons)
npm run lint       # n8n-node lint (n8n community-node rules, incl. eslint-plugin-n8n-nodes-base)
npm test           # jest unit tests
npm run smoke      # live: GET /me without a key must answer 401 (no key used)
npm run dev        # run a local n8n with these nodes loaded
```

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [PeerBie](https://peerbie.com)
- PeerBie public API base URL: `https://api.peerbie.com/api/public/v1`

## Version history

- **0.1.0**: first version. Workflow Get / Get Many, Run Start, Item Get Many, PeerBie Trigger (item created, item entered stage).

## License

[MIT](LICENSE.md)
