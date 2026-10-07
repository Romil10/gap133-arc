# gap133 on Arc

Pay-per-query access to [gap133](https://gap133.xyz)'s live, verified cross-venue prediction-market gaps, settled in USDC on [Arc](https://arc.io) mainnet.

No account, no subscription, no API key. A person or an AI agent pays 0.01 USDC for one answer, and every answer is signed so the caller can prove it came from gap133.

## Live on Arc mainnet

| | |
|---|---|
| Demo | https://arc.gap133.xyz |
| Contract | [`0x5EA8609e0DFA6F40b0c24CB3F766e37e91051585`](https://explorer.arc.io/address/0x5EA8609e0DFA6F40b0c24CB3F766e37e91051585) (source verified) |
| Attester | `0x12cEdf037e7cc9f26403267CE1704bE55c940FBb` (also readable from `attester()` on the contract) |
| Price | 0.01 USDC per query |
| Service info | https://arc.gap133.xyz/api/info |
| Free sample | https://arc.gap133.xyz/api/sample |
| Usage stats | https://arc.gap133.xyz/api/stats (counted on-chain) |

## Use it from an AI assistant (MCP)

`mcp/server.mjs` is an MCP server. Add it to Claude Desktop, Claude Code, Cursor or any MCP client and the assistant gets four tools:

| Tool | Cost | What it does |
|---|---|---|
| `gap133_sample` | free | The biggest verified gap from a 10-minute snapshot |
| `gap133_query` | 0.01 USDC | Live top gaps, after-fee gaps, or one pair, paid on Arc and signature-verified |
| `gap133_wallet` | free | The agent wallet's address, USDC balance and remaining session budget |
| `gap133_stats` | free | Usage counted from the contract's on-chain `Paid` events |

Claude Desktop config (`claude_desktop_config.json`). It needs Node 20+ and no git:

```json
{
  "mcpServers": {
    "gap133": {
      "command": "npx",
      "args": ["-y", "https://codeload.github.com/Romil10/gap133-arc/tar.gz/main"],
      "env": {
        "GAP133_AGENT_KEY": "0x... private key of a dedicated wallet with about $1 of USDC on Arc",
        "GAP133_MAX_SPEND_USDC": "0.10"
      }
    }
  }
}
```

Claude Code: `claude mcp add gap133 -e GAP133_AGENT_KEY=0x... -- npx -y https://codeload.github.com/Romil10/gap133-arc/tar.gz/main`

Without `GAP133_AGENT_KEY` the free tools still work. Before any payment the server checks that:

- the 402 names the **pinned** contract (`GAP133_CONTRACT`, default the live one), so a compromised website cannot redirect payment;
- the quoted price equals `price()` on-chain and is at most `GAP133_MAX_PRICE_USDC` (default 0.01);
- the session total stays within `GAP133_MAX_SPEND_USDC` (default 0.10). Paid calls run one at a time, so the limit cannot be raced.

After payment it trusts the answer only if it is signed by `attester()` read from that contract. Use a dedicated low-balance wallet, never your main one.

## Why Arc

- **USDC as gas.** Prices and fees are in dollars, and the caller needs only one asset.
- **Sub-second finality.** The service can confirm a payment and answer in the same request cycle.
- **Native USDC, 18 decimals.** Payment is plain `msg.value`, with no token-approval step, which keeps an agent's flow to one transaction.

## How it works

```
agent                       service (Vercel)                 Arc mainnet
  | GET /api/query?kind=top      |                               |
  |----------------------------->|                               |
  |  402 {nonce, challenge,      |                               |
  |       contract, price}       |                               |
  |<-----------------------------|                               |
  | pay(nonce)  value = 0.01 USDC                                |
  |------------------------------------------------------------->|
  | GET /api/query?kind=top      |                               |
  |  X-Payment-Challenge, X-Payment-Tx                           |
  |----------------------------->| read receipt, find Paid(nonce)|
  |                              |------------------------------>|
  |                              | fetch live desk data (gap133) |
  |  200 {data}  X-Signature     |                               |
  |<-----------------------------|                               |
```

1. The first request returns `402 Payment Required` with a one-time nonce and an HMAC-signed challenge bound to that exact query.
2. The caller sends `pay(nonce)` to the contract with exactly the price in native USDC.
3. The caller repeats the request with the challenge and the transaction hash. The service checks the challenge, reads the receipt on Arc, finds the `Paid(nonce)` event, and returns the data.
4. The response body is signed with EIP-191 by the **attester**, whose address is stored in the contract (`attester()`), so trust does not depend on the website.

A challenge is valid for 15 minutes and unlocks only the query it was issued for. The contract refuses a nonce that has already been paid.

### Queries

| `kind` | Returns |
|---|---|
| `top` | The five biggest verified gaps right now |
| `net` | Pairs still positive after both venues' taker fees |
| `pair` | One pair by Kalshi ticker (`&ticker=KX...`) |

### Free sample and usage stats

- `GET /api/sample` is free. It returns the single biggest verified gap from a snapshot refreshed every 10 minutes, unsigned, so anyone can see what the data looks like before paying.
- `GET /api/stats` returns paid queries, unique wallets and USDC collected, counted from the contract's `Paid` events on Arc rather than from a database. Arc's RPC limits log queries to 10,000 blocks, so totals up to a recent block are kept in `lib/stats-checkpoint.mjs`, refreshed daily by a GitHub Action, and the endpoint scans only the blocks since then.

Data comes from gap133's live desk tier: matched Polymarket/Limitless and Kalshi pairs that passed the deterministic matcher, a same-event check and a staleness gate, with fee-adjusted net gaps. Free visitors to gap133.xyz see a 10-minute-delayed board; paying here returns the live one.

## Repository

```
contracts/Gap133PayPerQuery.sol   the Arc contract (pay, price, attester, withdraw)
lib/core.mjs                      challenges, payment verification, data fetch, signing
api/query.js                      the 402 -> pay -> answer endpoint
api/info.js                       contract, price and attester
api/sample.js                     free, 10-minute-delayed sample gap
api/stats.js                      usage counted from on-chain Paid events
lib/stats.mjs                     chunked event scan with a committed checkpoint
scripts/update-checkpoint.mjs     recount job run daily by .github/workflows
public/index.html                 demo page (pay from MetaMask)
public/deploy.html                one-time deploy page
mcp/server.mjs                    MCP server for AI assistants (four tools, spending limits)
lib/client.mjs                    pay-and-verify client with pinned contract and price checks
examples/agent.mjs                autonomous agent: pays, then verifies the signature
test/e2e.mjs                      35 end-to-end checks on a local chain with chain id 5042
```

## Run the tests

```
npm install
npm run compile
npm test
```

The test suite deploys the contract to a local chain using Arc's chain id, drives the real API handlers through the full flow, and checks the failure cases: forged challenges, reused payments, wrong amounts, unknown transactions, and a paid challenge used for a different query.

## Deploy your own

Environment variables (set in your host, never committed):

| Variable | Purpose |
|---|---|
| `SERVICE_SECRET` | Long random phrase. The challenge HMAC key and the attester signing key are derived from it. The attester key holds no funds. |
| `DESK_KEY` | A gap133 desk key, used server-side only. |
| `CONTRACT_ADDRESS` | Set after deploying the contract. |

Then open `/deploy.html`, deploy from your wallet, and set `CONTRACT_ADDRESS`.

## Network

| | |
|---|---|
| Chain | Arc mainnet, chain id 5042 |
| RPC | https://rpc.mainnet.arc.io |
| Explorer | https://explorer.arc.io |

Market data only. Not trading advice.
