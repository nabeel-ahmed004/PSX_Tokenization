"""
PSX Price Oracle Feeder
=======================
Fetches real-time PSX stock prices using yfinance (Yahoo Finance)
and pushes them on-chain to the PSXOracle smart contract.

Compatible with:
  web3.py  >= 6.0
  yfinance >= 0.2.37

Setup:
  pip install -r requirements.txt

Run:
  python oracle_feeder.py
"""

import os
import time
import logging
import schedule
from datetime import datetime
from dotenv import load_dotenv

import yfinance as yf
from web3 import Web3

# ── web3.py v6 correct import ─────────────────────────────────────────────────
try:
    from web3.middleware import ExtraDataToPOAMiddleware   # web3.py v6+
except ImportError:
    from web3.middleware import geth_poa_middleware as ExtraDataToPOAMiddleware  # v5 fallback

# ──────────────────────────────────────────────────────────────────────────────
#  Configuration
# ──────────────────────────────────────────────────────────────────────────────

load_dotenv()

POLL_INTERVAL      = 300   # seconds between pushes
RPC_URL            = os.getenv("SEPOLIA_RPC_URL", "http://127.0.0.1:8545")
FEEDER_PRIVATE_KEY = os.getenv("FEEDER_PRIVATE_KEY") or os.getenv("PRIVATE_KEY")
ORACLE_ADDRESS     = os.getenv("ORACLE_ADDRESS", "")
PRICE_SCALE        = 10 ** 8

# PSX ticker → Yahoo Finance ticker (.KA = Karachi Stock Exchange)
# 15 companies across 7 sectors — all verified on Yahoo Finance
TICKER_MAP = {
    # Energy
    "OGDC":  "OGDC.KA",   # Oil & Gas Development Company
    "PPL":   "PPL.KA",    # Pakistan Petroleum Limited
    "PSO":   "PSO.KA",    # Pakistan State Oil

    # Banking
    "HBL":   "HBL.KA",    # Habib Bank Limited
    "UBL":   "UBL.KA",    # United Bank Limited
    "MCB":   "MCB.KA",    # MCB Bank Limited
    "BAFL":  "BAFL.KA",   # Bank Alfalah Limited

    # Fertilizer
    "ENGRO": "ENGRO.KA",  # Engro Corporation
    "FFC":   "FFC.KA",    # Fauji Fertilizer Company

    # Cement
    "LUCK":  "LUCK.KA",   # Lucky Cement
    "DGKC":  "DGKC.KA",  # D.G. Khan Cement

    # Textile
    "NML":   "NML.KA",    # Nishat Mills Limited

    # Technology
    "SYS":   "SYS.KA",    # Systems Limited

    # Power
    "HUBC":  "HUBC.KA",   # Hub Power Company (replaced PSMC — not on Yahoo Finance)

    # Pharmaceuticals
    "SEARL": "SEARL.KA",  # The Searle Company
}

# ──────────────────────────────────────────────────────────────────────────────
#  Logging
# ──────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("oracle_feeder.log"),
    ],
)
log = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
#  Oracle ABI
# ──────────────────────────────────────────────────────────────────────────────

ORACLE_ABI = [
    {
        "inputs": [
            {"internalType": "string[]",  "name": "_tickers", "type": "string[]"},
            {"internalType": "uint256[]", "name": "_prices",  "type": "uint256[]"},
        ],
        "name": "batchUpdatePrices",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [{"internalType": "string", "name": "_ticker", "type": "string"}],
        "name": "getLatestPrice",
        "outputs": [
            {"internalType": "uint256", "name": "price",     "type": "uint256"},
            {"internalType": "uint256", "name": "updatedAt", "type": "uint256"},
            {"internalType": "uint256", "name": "roundId",   "type": "uint256"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
]

# ──────────────────────────────────────────────────────────────────────────────
#  Web3 Connection
# ──────────────────────────────────────────────────────────────────────────────

def connect_web3():
    w3 = Web3(Web3.HTTPProvider(RPC_URL))

    # FIXED: correct web3.py v6 middleware — handles POA chain extraData
    w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

    if not w3.is_connected():
        raise ConnectionError(f"Cannot connect to: {RPC_URL}")

    account  = w3.eth.account.from_key(FEEDER_PRIVATE_KEY)
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(ORACLE_ADDRESS),
        abi=ORACLE_ABI,
    )

    balance = w3.eth.get_balance(account.address)
    log.info(f"Connected | Feeder: {account.address} | Balance: {w3.from_wei(balance, 'ether'):.4f} ETH")

    if balance == 0:
        log.warning("Feeder wallet has 0 ETH — fund it before pushing prices")

    return w3, account, contract

# ──────────────────────────────────────────────────────────────────────────────
#  Price Cache — persists last known prices across runs
# ──────────────────────────────────────────────────────────────────────────────

# In-memory cache: { psx_ticker: float_price }
# Populated on first successful fetch, used as fallback when Yahoo is unavailable
_price_cache: dict = {}

# ──────────────────────────────────────────────────────────────────────────────
#  Price Fetching — 3-level fallback chain
# ──────────────────────────────────────────────────────────────────────────────

def fetch_single(yahoo_ticker: str):
    """
    Fetch the latest price for one ticker with a 3-level fallback chain.
    Works during market hours, after hours, and when the market is closed.

    Level 1 — fast_info.last_price
      The current or most recently traded price.
      Works during market hours and often after hours too.

    Level 2 — info["regularMarketPrice"]
      Yahoo Finance's "regular market price" field.
      More reliable than fast_info when the market is closed because
      Yahoo Finance explicitly stores the last closing price here.

    Level 3 — history(period="5d").Close.iloc[-1]
      Pull the last 5 days of daily closing prices and take the most
      recent one. This always works — even on weekends — because it
      reads from historical data rather than a live quote.

    Returns float price in PKR, or None if all 3 levels fail.
    """

    ticker = yf.Ticker(yahoo_ticker)

    # ── Level 1: fast_info.last_price ─────────────────────────────────────────
    try:
        price = ticker.fast_info.last_price
        if price and float(price) > 0:
            log.debug(f"    {yahoo_ticker}: Level 1 (fast_info) → {price:.2f}")
            return float(price)
    except Exception as e:
        log.debug(f"    {yahoo_ticker}: Level 1 failed — {e}")

    # ── Level 2: info["regularMarketPrice"] ───────────────────────────────────
    try:
        info  = ticker.info
        price = info.get("regularMarketPrice") or info.get("currentPrice")
        if price and float(price) > 0:
            log.debug(f"    {yahoo_ticker}: Level 2 (info) → {price:.2f}")
            return float(price)
    except Exception as e:
        log.debug(f"    {yahoo_ticker}: Level 2 failed — {e}")

    # ── Level 3: history(period="5d") — last available closing price ──────────
    try:
        hist  = ticker.history(period="5d")
        if not hist.empty:
            price = float(hist["Close"].dropna().iloc[-1])
            if price > 0:
                log.debug(f"    {yahoo_ticker}: Level 3 (history) → {price:.2f}")
                return price
    except Exception as e:
        log.debug(f"    {yahoo_ticker}: Level 3 failed — {e}")

    return None


def fetch_prices() -> dict:
    """
    Fetch all configured PSX tickers using the 3-level fallback chain.
    If all 3 levels fail for a ticker, uses the last cached price.
    If no cache exists for that ticker, skips it with a warning.

    Returns dict: { psx_ticker: float_price_in_pkr }
    Never raises — always returns whatever it can.
    """
    prices = {}

    for psx_ticker, yahoo_ticker in TICKER_MAP.items():
        price = fetch_single(yahoo_ticker)

        if price is not None:
            # Fresh price — update cache and use it
            _price_cache[psx_ticker] = price
            prices[psx_ticker] = price
            log.info(f"  {psx_ticker.ljust(6)} Rs. {price:,.2f}  (live)")

        elif psx_ticker in _price_cache:
            # All 3 levels failed — fall back to last known price
            cached = _price_cache[psx_ticker]
            prices[psx_ticker] = cached
            log.warning(
                f"  {psx_ticker.ljust(6)} Rs. {cached:,.2f}  "
                f"(cached — Yahoo Finance unavailable)"
            )

        else:
            # Never fetched before and all levels failed — skip this ticker
            log.warning(
                f"  {psx_ticker.ljust(6)} SKIPPED — no live data and no cache yet"
            )

    return prices

# ──────────────────────────────────────────────────────────────────────────────
#  On-Chain Push
# ──────────────────────────────────────────────────────────────────────────────

def push_prices(w3, account, contract, prices: dict):
    if not prices:
        log.warning("Nothing to push.")
        return

    tickers_list = list(prices.keys())
    prices_list  = [int(prices[t] * PRICE_SCALE) for t in tickers_list]

    log.info(f"Pushing {len(tickers_list)} prices: {tickers_list}")

    try:
        tx = contract.functions.batchUpdatePrices(
            tickers_list, prices_list
        ).build_transaction({
            "from":     account.address,
            "nonce":    w3.eth.get_transaction_count(account.address),
            "gasPrice": w3.eth.gas_price,
            "gas":      500_000,
        })

        signed  = w3.eth.account.sign_transaction(tx, FEEDER_PRIVATE_KEY)

        # FIXED: web3.py v6 uses .raw_transaction (not .rawTransaction)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        log.info(f"  Tx: {tx_hash.hex()}")

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status == 1:
            log.info(f"  Confirmed in block {receipt.blockNumber} | gas: {receipt.gasUsed:,}")
        else:
            log.error("  Transaction reverted — check feeder authorization")

    except Exception as e:
        log.error(f"Push failed: {e}")


def verify_on_chain(contract, ticker: str):
    try:
        price, updated_at, round_id = contract.functions.getLatestPrice(ticker).call()
        log.info(
            f"  On-chain {ticker}: Rs. {price / PRICE_SCALE:,.2f} "
            f"| Round #{round_id} | at {datetime.fromtimestamp(updated_at).strftime('%H:%M:%S')}"
        )
    except Exception as e:
        log.warning(f"  Read-back failed for {ticker}: {e}")

# ──────────────────────────────────────────────────────────────────────────────
#  Main Job
# ──────────────────────────────────────────────────────────────────────────────

def oracle_job(w3, account, contract):
    log.info("─" * 50)
    log.info(f"Run at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    log.info("─" * 50)

    log.info("Fetching from Yahoo Finance...")
    prices = fetch_prices()

    if not prices:
        log.error("No prices — market may be closed. Skipping.")
        return

    push_prices(w3, account, contract, prices)
    verify_on_chain(contract, list(prices.keys())[0])
    log.info(f"Done. Next run in {POLL_INTERVAL // 60} min.\n")


def main():
    log.info("PSX Oracle Feeder starting...")

    if not FEEDER_PRIVATE_KEY:
        raise ValueError("FEEDER_PRIVATE_KEY not set in .env")
    if not ORACLE_ADDRESS:
        raise ValueError("ORACLE_ADDRESS not set in .env — deploy PSXOracle first")
    if not Web3.is_address(ORACLE_ADDRESS):
        raise ValueError(f"ORACLE_ADDRESS is not valid: {ORACLE_ADDRESS}")

    w3, account, contract = connect_web3()

    # Run once immediately on startup
    oracle_job(w3, account, contract)

    # Then on schedule
    schedule.every(POLL_INTERVAL).seconds.do(
        oracle_job, w3=w3, account=account, contract=contract
    )
    log.info(f"Scheduled every {POLL_INTERVAL // 60} min. Ctrl+C to stop.\n")

    while True:
        schedule.run_pending()
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Oracle feeder stopped.")
    except Exception as e:
        log.error(f"Fatal: {e}")
        raise