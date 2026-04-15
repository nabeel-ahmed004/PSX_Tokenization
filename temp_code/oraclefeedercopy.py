"""
PSX Price Oracle Feeder
=======================
Fetches real-time PSX stock prices from the official PSX data portal
(dps.psx.com.pk) and pushes them on-chain to the PSXOracle smart contract.

Data source: https://dps.psx.com.pk  (reverse-engineered from frontend JS)
  /timeseries/int/{symbol}  →  [[unix_ts, price, volume], ...]   intraday ticks
  /timeseries/eod/{symbol}  →  [[unix_ts, close, volume, open], ...]  daily EOD

Compatible with: 
  web3.py  >= 6.0
  requests >= 2.31

Setup:
  pip install web3 requests python-dotenv schedule

Run:
  python oracle_feeder.py
"""

import os
import time
import logging
import schedule
import requests
from datetime import datetime, date
from dotenv import load_dotenv

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

# PSX ticker symbols — used directly with dps.psx.com.pk API
# No Yahoo Finance suffix needed; these are the canonical PSX symbols
TICKER_MAP = {
    # Energy
    "OGDC":  "OGDC",   # Oil & Gas Development Company
    "PPL":   "PPL",    # Pakistan Petroleum Limited
    "PSO":   "PSO",    # Pakistan State Oil

    # Banking
    "HBL":   "HBL",    # Habib Bank Limited
    "UBL":   "UBL",    # United Bank Limited
    "MCB":   "MCB",    # MCB Bank Limited
    "BAFL":  "BAFL",   # Bank Alfalah Limited

    # Fertilizer
    "ENGRO": "ENGRO",  # Engro Corporation
    "FFC":   "FFC",    # Fauji Fertilizer Company

    # Cement
    "LUCK":  "LUCK",   # Lucky Cement
    "DGKC":  "DGKC",  # D.G. Khan Cement

    # Textile
    "NML":   "NML",    # Nishat Mills Limited

    # Technology
    "SYS":   "SYS",    # Systems Limited

    # Power
    "HUBC":  "HUBC",   # Hub Power Company

    # Pharmaceuticals
    "SEARL": "SEARL",  # The Searle Company
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

    # Handles POA chain extraData field (required for Sepolia / testnets)
    w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

    if not w3.is_connected():
        raise ConnectionError(f"Cannot connect to: {RPC_URL}")

    account  = w3.eth.account.from_key(FEEDER_PRIVATE_KEY)
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(ORACLE_ADDRESS),
        abi=ORACLE_ABI,
    )

    balance = w3.eth.get_balance(account.address)
    log.info(
        f"Connected | Feeder: {account.address} | "
        f"Balance: {w3.from_wei(balance, 'ether'):.4f} ETH"
    )

    if balance == 0:
        log.warning("Feeder wallet has 0 ETH — fund it before pushing prices")

    return w3, account, contract

# ──────────────────────────────────────────────────────────────────────────────
#  Price Cache — in-memory, persists last known price per ticker per process run
# ──────────────────────────────────────────────────────────────────────────────

_price_cache: dict = {}   # { psx_ticker: float_price }

# ──────────────────────────────────────────────────────────────────────────────
#  PSX Official API helpers
# ──────────────────────────────────────────────────────────────────────────────

PSX_BASE    = "https://dps.psx.com.pk"
PSX_HEADERS = {
    "User-Agent":       "Mozilla/5.0",
    "X-Requested-With": "XMLHttpRequest",
}
PSX_TIMEOUT = 10  # seconds per request


def _psx_get(path: str) -> dict | None:
    """
    GET a single PSX API path and return parsed JSON.
    Returns None on any network or parse error — never raises.
    """
    try:
        r = requests.get(
            PSX_BASE + path,
            headers=PSX_HEADERS,
            timeout=PSX_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.debug(f"PSX request failed [{path}]: {e}")
        return None


# ──────────────────────────────────────────────────────────────────────────────
#  Price Fetching — 2-level fallback chain (intraday → EOD)
# ──────────────────────────────────────────────────────────────────────────────

def fetch_single(psx_ticker: str) -> float | None:
    """
    Fetch the latest price for one PSX ticker using the official PSX data API.

    Level 1 — /timeseries/int/{ticker}  (intraday ticks)
      Returns [[unix_ts, price, volume], ...] sorted newest-first.
      The first entry is the most recently traded price.
      Works during market hours (09:30–15:30 PKT, Mon–Fri).
      Falls back gracefully if the market is closed or the feed is empty.

    Level 2 — /timeseries/eod/{ticker}  (end-of-day history)
      Returns [[unix_ts, close, volume, open], ...] sorted newest-first.
      The first entry is the most recent session's closing price.
      Always available — used outside market hours and as a safety net.

    Returns float price in PKR, or None if both levels fail.
    """

    # ── Level 1: intraday ticks ───────────────────────────────────────────────
    try:
        resp = _psx_get(f"/timeseries/int/{psx_ticker}")
        if resp and resp.get("status") == 1:
            data = resp.get("data", [])
            if data:
                price = float(data[0][1])
                if price > 0:
                    log.debug(f"    {psx_ticker}: Level 1 (intraday) → {price:.2f}")
                    return price
    except Exception as e:
        log.debug(f"    {psx_ticker}: Level 1 failed — {e}")

    # ── Level 2: EOD history ──────────────────────────────────────────────────
    try:
        resp = _psx_get(f"/timeseries/eod/{psx_ticker}")
        if resp and resp.get("status") == 1:
            data = resp.get("data", [])
            if data:
                price = float(data[0][1])
                if price > 0:
                    log.debug(f"    {psx_ticker}: Level 2 (EOD) → {price:.2f}")
                    return price
    except Exception as e:
        log.debug(f"    {psx_ticker}: Level 2 failed — {e}")

    return None


def fetch_prices() -> dict:
    """
    Fetch all configured PSX tickers.
    On failure for a ticker, falls back to last cached price.
    If no cache exists for that ticker, skips it with a warning.

    Returns dict: { psx_ticker: float_price_in_pkr }
    Never raises — always returns whatever it can.
    """
    prices = {}

    for psx_ticker in TICKER_MAP:
        price = fetch_single(psx_ticker)

        if price is not None:
            _price_cache[psx_ticker] = price
            prices[psx_ticker] = price
            log.info(f"  {psx_ticker.ljust(6)} Rs. {price:,.2f}")

        elif psx_ticker in _price_cache:
            cached = _price_cache[psx_ticker]
            prices[psx_ticker] = cached
            log.warning(
                f"  {psx_ticker.ljust(6)} Rs. {cached:,.2f}  "
                f"(cached — PSX API unavailable)"
            )

        else:
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

        # web3.py v6 uses .raw_transaction (not .rawTransaction)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        log.info(f"  Tx: {tx_hash.hex()}")

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status == 1:
            log.info(
                f"  Confirmed in block {receipt.blockNumber} | "
                f"gas: {receipt.gasUsed:,}"
            )
        else:
            log.error("  Transaction reverted — check feeder authorization")

    except Exception as e:
        log.error(f"Push failed: {e}")


def verify_on_chain(contract, ticker: str):
    try:
        price, updated_at, round_id = contract.functions.getLatestPrice(ticker).call()
        log.info(
            f"  On-chain {ticker}: Rs. {price / PRICE_SCALE:,.2f} "
            f"| Round #{round_id} "
            f"| at {datetime.fromtimestamp(updated_at).strftime('%H:%M:%S')}"
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

    log.info("Fetching from PSX official API (dps.psx.com.pk)...")
    prices = fetch_prices()

    if not prices:
        log.error("No prices fetched — skipping this round.")
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