// test/helpers.js
// Shared fixtures and utilities used across all PSX test files

const { ethers } = require("hardhat");

// ─── Constants ────────────────────────────────────────────────────────────────

const DECIMALS       = 18n;
const ONE_TOKEN      = 10n ** DECIMALS;           // 1 share token (1e18)
const PRICE_SCALE    = 10n ** 8n;                 // oracle price scaling

// Sample companies used in tests
const COMPANIES = [
  { name: "Oil & Gas Development Company", ticker: "OGDC", sector: "Energy",   supply: 1_000_000n },
  { name: "Habib Bank Limited",            ticker: "HBL",  sector: "Banking",  supply:   500_000n },
  { name: "Pakistan State Oil",            ticker: "PSO",  sector: "Energy",   supply:   750_000n },
];

// ─── Fixture: deploy everything ───────────────────────────────────────────────

async function deployAll() {
  const [admin, feeder, alice, bob, charlie] = await ethers.getSigners();

  // 1. Factory
  const Factory = await ethers.getContractFactory("PSXTokenFactory");
  const factory = await Factory.connect(admin).deploy();
  await factory.waitForDeployment();

  // 2. Exchange
  const Exchange = await ethers.getContractFactory("PSXExchange");
  const exchange = await Exchange.connect(admin).deploy(await factory.getAddress());
  await exchange.waitForDeployment();

  // 3. Oracle
  const Oracle = await ethers.getContractFactory("PSXOracle");
  const oracle = await Oracle.connect(admin).deploy();
  await oracle.waitForDeployment();

  // 4. List companies & create pools
  const tokens = {};
  const pools  = {};

  for (const c of COMPANIES) {
    await factory.connect(admin).listCompany(c.name, c.ticker, c.sector, c.supply);
    const tokenAddr = await factory.getTokenAddress(c.ticker);
    tokens[c.ticker] = await ethers.getContractAt("PSXToken", tokenAddr);

    await exchange.connect(admin).createPool(c.ticker);
    const poolAddr = await exchange.getPool(tokenAddr);
    pools[c.ticker] = await ethers.getContractAt("LiquidityPool", poolAddr);
  }

  // 5. Authorize feeder on oracle
  await oracle.connect(admin).setFeeder(feeder.address, true);

  // 6. Register oracle tickers
  await oracle.connect(admin).registerTickers(COMPANIES.map(c => c.ticker));

  return { admin, feeder, alice, bob, charlie, factory, exchange, oracle, tokens, pools };
}

// ─── Helper: whitelist a user on a token ──────────────────────────────────────

async function whitelistOn(token, admin, ...users) {
  for (const user of users) {
    await token.connect(admin).setWhitelist(user.address, true);
  }
}

// ─── Helper: seed a pool with initial liquidity ───────────────────────────────

async function seedPool(exchange, token, admin, ethAmount, tokenAmount) {
  const tokenAddr = await token.getAddress();
  await token.connect(admin).approve(await exchange.getAddress(), tokenAmount);
  await exchange.connect(admin).addLiquidity(tokenAddr, tokenAmount, 0n, { value: ethAmount });
}

// ─── Helper: parse token amount (whole shares → uint256) ─────────────────────

function shares(n) {
  return BigInt(n) * ONE_TOKEN;
}

// ─── Helper: parse ETH amount ────────────────────────────────────────────────

function eth(n) {
  return ethers.parseEther(String(n));
}

// ─── Helper: oracle price (PKR float → uint256 scaled 1e8) ───────────────────

function pkr(n) {
  return BigInt(Math.round(n * 1e8));
}

module.exports = {
  COMPANIES, ONE_TOKEN, PRICE_SCALE,
  deployAll, whitelistOn, seedPool, shares, eth, pkr,
};
