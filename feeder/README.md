# PSX Oracle Feeder — Setup Guide

## How It Works

```
Yahoo Finance (yfinance)
        ↓  every 5 min
  oracle_feeder.py          ← runs on your laptop / server
        ↓  batchUpdatePrices()
   PSXOracle.sol            ← on Sepolia blockchain
        ↓  getLatestPrice()
   PSXExchange / DApp       ← reads reference prices
```

## Step 1 — Deploy PSXOracle

Add `PSXOracle` to your deploy script and run:
```bash
npx hardhat run scripts/deploy.js --network sepolia
```
Copy the deployed oracle address into your `.env`:
```
ORACLE_ADDRESS=0x...
```

## Step 2 — Register Tickers On-Chain

After deployment, call `registerTickers()` on the oracle contract
(via Etherscan or a script) with your PSX tickers:
```
["OGDC", "HBL", "PSO", "LUCK", "UBL", "ENGRO", "MCB", "PPL"]
```

## Step 3 — Fund the Feeder Wallet

Get free Sepolia ETH from a faucet:
- https://sepoliafaucet.com
- https://faucet.quicknode.com/ethereum/sepolia

Each price update costs ~0.001–0.003 Sepolia ETH in gas.
0.1 ETH covers ~100+ updates comfortably.

## Step 4 — Install Python Dependencies

```bash
cd oracle
pip install -r requirements.txt
```

## Step 5 — Run the Feeder

```bash
python oracle_feeder.py
```

You will see output like:
```
2024-01-15 10:00:00 [INFO] Connected to Sepolia | Feeder: 0xAbc... | Balance: 0.0950 ETH
2024-01-15 10:00:01 [INFO] Fetching prices from Yahoo Finance...
2024-01-15 10:00:03 [INFO]   OGDC: Rs. 182.50
2024-01-15 10:00:03 [INFO]   HBL:  Rs. 145.30
2024-01-15 10:00:03 [INFO]   PSO:  Rs. 310.75
2024-01-15 10:00:03 [INFO] Pushing prices to PSXOracle contract...
2024-01-15 10:00:18 [INFO]   ✅ Confirmed in block 5123456 | Gas used: 187432
2024-01-15 10:00:18 [INFO]   On-chain OGDC: Rs. 182.50 | Round #1 | Updated at 10:00:15
2024-01-15 10:00:18 [INFO] ✅ Done. Next run in 5 minutes.
```

## Adding More Tickers

Edit `TICKER_MAP` in `oracle_feeder.py`:
```python
TICKER_MAP = {
    "OGDC":  "OGDC.KA",
    "MYNEW": "MYNEW.KA",   # add any PSX ticker with .KA suffix
}
```
Then call `registerTicker("MYNEW")` on the oracle contract.

## Notes

- Yahoo Finance data has a ~15 minute delay for KSE stocks.
- If a ticker returns no data, the feeder skips it and logs a warning.
- Logs are saved to `oracle_feeder.log` alongside the script.
- For FYP demo, running the script manually once before the demo is fine.
