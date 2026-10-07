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

Data comes from gap133's live desk tier: matched Polymarket/Limitless and Kalshi pairs that passed the deterministic matcher, a same-event check and a staleness gate, with fee-adjusted net gaps. Free visitors to gap133.xyz see a 10-minute-delayed board; paying here returns the live one.

## Repository

```
contracts/Gap133PayPerQuery.sol   the Arc contract (pay, price, attester, withdraw)
lib/core.mjs                      challenges, payment verification, data fetch, signing
api/query.js                      the 402 -> pay -> answer endpoint
api/info.js                       contract, price and attester
public/index.html                 demo page (pay from MetaMask)
public/deploy.html                one-time deploy page
examples/agent.mjs                autonomous agent: pays, then verifies the signature
test/e2e.mjs                      20 end-to-end checks on a local chain with chain id 5042
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
