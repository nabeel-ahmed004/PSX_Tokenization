# PSX://chain — DApp Frontend

## Tech Stack
- **React 18** + **Vite**
- **ethers.js v6** — blockchain interaction
- **DM Sans + DM Mono** — typography
- Zero external UI libraries — all components hand-built

## Pages & Roles

| Page          | Role           | Description                                      |
|---------------|----------------|--------------------------------------------------|
| Landing       | All            | Wallet connect, role detection                   |
| Portfolio     | Investor/Admin | Holdings, KYC status, portfolio overview         |
| Market        | Investor/Admin | Live prices, buy/sell shares via AMM             |
| KYC Apply     | Investor       | Submit identity verification request             |
| KYC Review    | KYC Checker    | Approve/reject applications, whitelist on-chain  |
| Admin Panel   | Admin          | List companies, create pools, withdraw fees      |

## Role Detection

Roles are detected automatically on wallet connect:
- **Admin** — wallet matches `factory.admin()` or `exchange.admin()`
- **KYC Checker** — wallet is authorized as oracle feeder (`oracle.isFeeder()`)
- **Investor** — everyone else

## Setup

```bash
cd frontend

# 1. Install dependencies
npm install

# 2. Set contract addresses
cp .env.example .env
# Edit .env with your deployed addresses

# 3. Run dev server
npm run dev
```

Open http://localhost:5173 and connect MetaMask (set network to Sepolia).

## Features

- 🌙/☀️ **Dark/Light mode** — persisted in localStorage
- 🦊 **MetaMask wallet connection** with auto role detection
- 📊 **Portfolio dashboard** — real token balances from chain
- 📈 **Live market prices** — from PSXOracle contract
- 💱 **Buy/sell with live quotes** — AMM price calculation before trade
- 🔍 **Stock search** — filter by ticker or company name
- ✅ **KYC workflow** — apply → review → on-chain whitelist approval
- 🏛️ **Admin panel** — list companies, create pools, withdraw fees
- 📋 **Slippage protection** — set minimum output on every trade

## Building for Production

```bash
npm run build
# Output in ./dist — deploy to Vercel, Netlify, or IPFS
```

## Notes

- KYC applications are stored in `localStorage` for the demo.
  In production, replace with a backend API + database.
- The oracle price feed requires the Python feeder script running.
  Without it, prices will show as stale.
- All trades go through MetaMask — users sign every transaction.
