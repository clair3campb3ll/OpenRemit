# Fireline — Community Fire-Relief Mutual on OpenRemit

> A two-layer mutual relief fund built on Open Payments, extending the OpenRemit hackathon template.
---

## The Pitch

**Persona:** Nomsa, a member of a church congregation in an informal settlement (e.g. Khayelitsha). Exposed to shack fires, excluded from formal insurance, no fast source of cash in the immediate aftermath.

**Problem:** When a shack fire destroys a household's belongings in an informal settlement, residents have no access to formal insurance and no fast source of cash in the critical first 48 hours — for shelter, food, transport, or replacing lost documents. Existing help from NGOs and the municipality arrives days later.

**Solution:** A two-layer community relief fund on Open Payments: members of an existing trusted group (a church congregation) pre-fund a pool held by a licensed custodian that pays a fixed relief amount directly to a verified fire-affected member's wallet within hours, backed by an externally funded backstop tranche sized to absorb settlement-wide events the member pool alone cannot.

**Honest scope:** This is **capped bridging relief, not insurance.** Fast, small, dignified, first-response cash — a bridge until NGOs/municipal disaster relief arrive.

**Event:** UCT Financial Innovation Hub Bootcamp hackathon. Team of 3. Scored out of 20: Quality of idea (5) / Potential strategic impact (5) / Implementation incl. Open Payments (5) / UX & presentation (5). Framing course: financial inclusion.

---

## Quick Start

### Prerequisites

- **Node.js 20+**
- An account at [wallet.interledger-test.dev](https://wallet.interledger-test.dev) with a key pair generated and uploaded

### 1. Clone & install

```bash
git clone https://github.com/clair3campb3ll/OpenRemit.git openremit && cd openremit
npm install
```

### 2. Get your wallet credentials

1. Create an account in the **Interledger Test Wallet** (<https://wallet.interledger-test.dev>).
2. Create **one wallet address** — this single address is used for both the pool and the backstop in the demo(in real world would be different).
3. Generate a **key pair** for your account (**Settings → Developer Keys → Add Key**). You'll get a **Key ID** and a **private key file** (e.g. `private.key`). Keep the private key on the machine that runs the backend.

> **Demo vs. production:** For the demo, `OP_WALLET_ADDRESS` and `BACKSTOP_WALLET_ADDRESS` point to the **same wallet address**, and both use the same key ID and private key. In a real deployment, the pool and backstop would be separate custodian wallets with separate keys.

### 3. Configure

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

| Variable | Description |
|---|---|
| `OP_WALLET_ADDRESS` | Your wallet address URL, e.g. `https://ilp.interledger-test.dev/yourname` |
| `OP_KEY_ID` | The UUID shown next to your key in **Settings → Developer Keys** |
| `OP_PRIVATE_KEY_PATH` | Path to the downloaded `.key` file, e.g. `./private.key` |
| `BACKSTOP_WALLET_ADDRESS` | **Same value as `OP_WALLET_ADDRESS`** for the demo |
| `BACKSTOP_KEY_ID` | **Same value as `OP_KEY_ID`** for the demo |
| `BACKSTOP_PRIVATE_KEY_PATH` | **Same value as `OP_PRIVATE_KEY_PATH`** for the demo |

A fully filled-out `.env` looks like this:

```env
# Pool wallet (Layer 1 — member contributions)
OP_WALLET_ADDRESS=https://ilp.interledger-test.dev/yourname
OP_KEY_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
OP_PRIVATE_KEY_PATH=./private.key

# Backstop wallet (Layer 2 — outside capital)
# For the demo, set these to the same values as above
BACKSTOP_WALLET_ADDRESS=https://ilp.interledger-test.dev/yourname
BACKSTOP_KEY_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
BACKSTOP_PRIVATE_KEY_PATH=./private.key

# URLs (defaults work for local dev)
FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:3001
VITE_BACKEND_URL=http://localhost:3001
```

### 4. Initialise the database

```bash
npm run db:push
```

### 5. Seed demo data 

```bash
cd backend && npm run demo:seed
```

This wipes any existing data and creates two ready-to-use accounts:

| Email | Password | Role |
|---|---|---|
| `admin@demo.com` | `demo` | ADMIN — views all claims |
| `alice@demo.com` | `demo` | MEMBER — reports a fire |

### 6. Start

```bash
npm run dev      # backend :3001 + frontend :5173
```

Open [http://localhost:5173](http://localhost:5173).

---

## Two-Layer Architecture

- **Layer 1 — member pool (speed):** funded by member contributions, held by a licensed custodian. Covers everyday single-shack fires in full. On a large event, fires the first capped response before hitting its limit.
- **Layer 2 — backstop tranche (scale):** a separate, outside-funded wallet (NGO / municipal / CSR). Guarantees the fixed payout up to a **design capacity** and absorbs settlement-wide (covariate) events, because the capital isn't inside the settlement and isn't wiped out with it.

**Why two layers, not one:** each layer is matched to the risk it can actually bear. Member pool = uncorrelated capital for the common case. Backstop = capital uncorrelated with the local peril, for the tail case. This maps onto the standard insurance "reserves + reinsurance" pattern.

**Covariate classification:** the number of verified claims from one location within the reporting window is the signal. One claim → `SINGLE` → member pool. Several near-simultaneous claims from the same location → `COVARIATE` → backstop unlocks too.

---

## Payout Decision Logic

On **trigger** for a verified claim:

1. Classify the event: `claimCount >= covariateThreshold` ⇒ `COVARIATE`, else `SINGLE`.
2. Choose source:
   - `SINGLE` **and** pool balance − `fixedPayoutAmount` ≥ `reserveFloor` ⇒ **POOL**.
   - otherwise (covariate, or paying would breach the floor) ⇒ **BACKSTOP**.
3. Run `quoteFlow` against the **victim** wallet, then create the outgoing payment from the chosen source wallet for **exactly `fixedPayoutAmount`**.
4. Record `transactions` + update `claims` (`status = PAID`, `payoutSource`, tx ref).
5. Log the branch taken so the **covariate path is visible** in the demo.

---

## Open Payments Flow

```
  Frontend                 Backend                   Open Payments Network
  ──────────────────────   ──────────────────────── ────────────────────────
  1. Fill in form          POST /api/remit/quote
     (wallets + amount)    ├─ walletAddress.get()   ──► Resolve both wallets
                           ├─ grant.request()       ──► Incoming-payment grant
                           ├─ incomingPayment.create()► Create incoming payment
                           ├─ grant.request()       ──► Quote grant
                           └─ quote.create()        ──► Get quote & fee

  2. Review quote          POST /api/remit/consent
     → click Authorise     ├─ grant.request()       ──► Interactive outgoing grant
                           └─ returns interactUrl

  3. Browser redirected ──────────────────────────────► Auth server consent page
     to auth server                                      (user approves)

  4. Auth server       ──► GET /api/callback
     redirects back        ├─ grant.continue()      ──► Exchange interact_ref
                           ├─ outgoingPayment.create()► Execute payment
                           └─ redirect to frontend

  5. Status view polls     GET /api/remit/status/:id
     until COMPLETED
```

**Remit routes:**
- `POST /api/remit/quote` — resolve wallets, create incoming payment + quote
- `POST /api/remit/consent` — request interactive outgoing grant, get interact URL
- `GET /api/callback` — continue grant, create outgoing payment
- `GET /api/remit/status/:id` — poll current transaction state
- `GET /api/remit/history` — the current user's sent payments
- `GET /api/remit/wallet-info?url=…` — resolve a wallet's currency before quoting

**Auth routes** (all remit routes except `/status/:id` require a `Bearer` token):
- `POST /api/auth/signup`, `POST /api/auth/login` — issue a 7-day JWT
- `GET /api/auth/me`, `PATCH /api/auth/me` — read / update the profile
- `GET /api/users/search?q=…` — find recipients by display name
- `GET /api/users/:id` — public profile + transactions shared with the current user

**Payment requests ("asks"):**
- `POST /api/requests` — ask another user to send you money
- `GET /api/requests` — `{ incoming, outgoing }` asks for the current user
- `POST /api/requests/:id/fulfill` — payer accepts: runs the shared quote flow
- `POST /api/requests/:id/decline` (payer), `POST /api/requests/:id/cancel` (requester)

**Claims (Fireline):**
- `POST /api/claims` — file a claim (creates `claims` row + associates/creates an `event`)
- `POST /api/claims/:id/verify` — mark verified (simulated attestation gate for demo)
- `POST /api/claims/:id/payout` — trigger payout: classify event, choose source, run quote + outgoing payment

---

## File Structure

```
OpenRemit/
├── package.json               ← workspace root, `npm run dev` starts everything
│
├── backend/
|   ├── examples/
|   │   └── p2p-open-payments-walkthrough.ts ← SDK usage example (good reference)
│   ├── src/
│   │   ├── index.ts           ← Express entry point — mount routes here
│   │   ├── config.ts          ← All env vars in one place
│   │   ├── lib/
│   │   │   ├── openPayments.ts← SDK client singleton (start here for OP changes)
│   │   │   ├── quoteFlow.ts   ← shared resolve → incoming payment → quote flow
│   │   │   └── seedNews.ts    ← seeds the demo News articles on first boot
│   │   ├── db/
│   │   │   ├── schema.ts      ← Database tables
│   │   │   └── index.ts       ← Drizzle + libsql (SQLite file) instance
│   │   ├── routes/
│   │   │   ├── remit.ts       ← wallet-info / quote / consent / status / history
│   │   │   ├── callback.ts    ← GNAP redirect handler
│   │   │   ├── auth.ts        ← signup / login / profile (JWT)
│   │   │   ├── users.ts       ← user search + public profiles
│   │   │   ├── requests.ts    ← payment requests ("asks")
│   │   │   ├── claims.ts      ← Fireline claims + payout trigger
│   │   │   └── news.ts        ← Web Monetization news demo
│   │   └── middleware/
│   │       ├── requireAuth.ts ← Bearer-token guard, sets req.user
│   │       └── errorHandler.ts
│   └── drizzle.config.ts
│
└── frontend/
    ├── index.html             ← Header + nav shell; views render into #view
    └── src/
        ├── main.ts            ← Hash router (#/login, #/remit, …) — boot here
        ├── api.ts             ← Typed fetch wrappers for every backend route
        ├── auth.ts            ← JWT storage helpers (localStorage)
        ├── escape.ts          ← escapeHtml() — use for anything user-entered
        ├── styles.css         ← Edit :root vars to rebrand
        └── views/
            ├── homeView.ts
            ├── loginView.ts / signupView.ts
            ├── profileView.ts
            ├── publicProfileView.ts
            ├── quoteView.ts
            ├── consentView.ts
            ├── statusView.ts
            ├── historyView.ts
            ├── receiveView.ts
            ├── claimView.ts         ← Report a fire + trigger payout (Fireline)
            ├── newsView.ts
            └── newsArticleView.ts
```

---

## Database Schema

- `users` — JWT auth via bcrypt password hash, optional wallet address + avatar
- `transactions` — reused for payout records; statuses: `PENDING → AWAITING_GRANT → COMPLETED | FAILED`
- `payment_requests` — asks: `PENDING → COMPLETED | DECLINED | CANCELLED`
- `groups` — mutual config: `name`, `poolWalletRef`, `backstopWalletRef`, `fixedPayoutAmount`, `reserveFloor`, `covariateThreshold`, `designCapacity`
- `events` — `groupId`, `location`, `occurredAt`, `reportedAt`, `classification` (`SINGLE | COVARIATE`), `claimCount`
- `claims` — `groupId`, `eventId`, `claimantWallet`, `status` (`PENDING → VERIFIED → PAID | REJECTED`), `payoutAmount`, `payoutSource` (`POOL | BACKSTOP`), tx ref

`members` / `contributions` tables are reserved for future work — not built for the demo.

---

## Constraints — Do Not Change These

- **Fixed payout per verified claim.** Equal amount for everyone. **Not pro-rata, not first-come-first-served.** Do not add allocation logic.
- **No spend control.** Funds go to the victim's wallet; the system never restricts or tracks how they are spent. Backed by cash-transfer evidence (e.g. GiveDirectly RCTs). If a backstop funder demands accountability, the answer is light-touch aggregate reporting — never per-purchase tracking.
- **Recipient integrity instead of spend control.** The victim's wallet is **bound at enrolment** (calm, pre-crisis, verified via the church). Payout only ever goes to that bound wallet.
- **Reserve floor.** The pool is never drawn below a configured floor `X`. A claim that would breach the floor draws from the **backstop** instead.
- **48-hour reporting window.** A claim must be filed within 48 hours of the fire. The victim *or* a member of the trusted group can file on their behalf.
- **Verification posture.** Community **M-of-N attestation**. Rigour is deliberately proportional to the small capped payout. Fraud is *managed*, not eliminated.

---

## Available Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start backend (:3001) + frontend (:5173) |
| `npm run build` | Build both packages |
| `npm run db:push` | Push schema changes to SQLite (no migration files needed) |
| `cd backend && npm run demo:seed` | Wipe all data and create demo accounts (`admin@demo.com` / `alice@demo.com`, password: `demo`) |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing required environment variable: OP_WALLET_ADDRESS` | Copy `backend/.env.example` → `backend/.env` and fill in credentials |
| `Grant continuation did not return an access token` | Consent was denied, expired, or already used — try again from the quote step |
| `Expected non-interactive incoming-payment grant` | The receiver's wallet requires interactive consent for incoming payments (rare on testnet) |
| Frontend can't reach backend | Check `VITE_BACKEND_URL` in `frontend/.env` (default: `http://localhost:3001`) and that CORS allows your frontend origin |
