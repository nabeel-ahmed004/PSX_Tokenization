// scripts/deploy.js
// Run with: npx hardhat run scripts/deploy.js --network sepolia
//       or: npx hardhat run scripts/deploy.js --network localhost

require("dotenv").config();
const { ethers, network, hre } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("===========================================");
  console.log("  PSX Tokenization Platform — Deployment  ");
  console.log("===========================================");
  console.log(`Deployer  : ${deployer.address}`);
  console.log(`Network   : ${network.name}`);
  console.log(`Balance   : ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log("-------------------------------------------\n");

  // ─── 1. Deploy PSXTokenFactory ───────────────────────────────────────────
  console.log("1️⃣  Deploying PSXTokenFactory...");
  const Factory = await ethers.getContractFactory("PSXTokenFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`   ✅ PSXTokenFactory  : ${factoryAddr}\n`);

  // ─── 2. Deploy PSXExchange ────────────────────────────────────────────────
  console.log("2️⃣  Deploying PSXExchange...");
  const Exchange = await ethers.getContractFactory("PSXExchange");
  const exchange = await Exchange.deploy(factoryAddr);
  await exchange.waitForDeployment();
  const exchangeAddr = await exchange.getAddress();
  console.log(`   ✅ PSXExchange      : ${exchangeAddr}\n`);

  // ─── 3. Deploy PSXOracle ─────────────────────────────────────────────────
  console.log("3️⃣  Deploying PSXOracle...");
  const Oracle = await ethers.getContractFactory("PSXOracle");
  const oracle = await Oracle.deploy();
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`   ✅ PSXOracle        : ${oracleAddr}\n`);

  // ─── 4. List Sample Companies ─────────────────────────────────────────────
  console.log("4️⃣  Listing sample PSX companies...");

  // 15 major PSX-listed companies across 7 sectors
  // Supply figures are representative (in whole shares, 18 decimals added by contract)
  const companies = [
    // ── Energy ──────────────────────────────────────────────────────────────
    { name: "Oil & Gas Development Company", ticker: "OGDC",  sector: "Energy",          supply: 4_300_000_000 },
    { name: "Pakistan Petroleum Limited",    ticker: "PPL",   sector: "Energy",          supply: 1_600_000_000 },
    { name: "Pakistan State Oil",            ticker: "PSO",   sector: "Energy",          supply:   350_000_000 },

    // ── Banking ──────────────────────────────────────────────────────────────
    { name: "Habib Bank Limited",            ticker: "HBL",   sector: "Banking",         supply: 1_466_000_000 },
    { name: "United Bank Limited",           ticker: "UBL",   sector: "Banking",         supply: 1_224_000_000 },
    { name: "MCB Bank Limited",              ticker: "MCB",   sector: "Banking",         supply: 1_184_000_000 },
    { name: "Bank Alfalah Limited",          ticker: "BAFL",  sector: "Banking",         supply: 1_579_000_000 },

    // ── Fertilizer ────────────────────────────────────────────────────────────
    { name: "Engro Corporation",             ticker: "ENGRO", sector: "Fertilizer",      supply:   534_000_000 },
    { name: "Fauji Fertilizer Company",      ticker: "FFC",   sector: "Fertilizer",      supply: 1_272_000_000 },

    // ── Cement ────────────────────────────────────────────────────────────────
    { name: "Lucky Cement Limited",          ticker: "LUCK",  sector: "Cement",          supply:   323_000_000 },
    { name: "D.G. Khan Cement Company",      ticker: "DGKC",  sector: "Cement",          supply:   503_000_000 },

    // ── Textile ───────────────────────────────────────────────────────────────
    { name: "Nishat Mills Limited",          ticker: "NML",   sector: "Textile",         supply:   546_000_000 },

    // ── Technology ───────────────────────────────────────────────────────────
    { name: "Systems Limited",               ticker: "SYS",   sector: "Technology",      supply:   151_000_000 },

    // ── Power ────────────────────────────────────────────────────────────────
    { name: "Hub Power Company Limited",      ticker: "HUBC",  sector: "Power",           supply: 1_176_000_000 },

    // ── Pharmaceuticals ───────────────────────────────────────────────────────
    { name: "The Searle Company",            ticker: "SEARL", sector: "Pharmaceuticals", supply:   201_000_000 },
  ];

  const tokenAddresses = {};

  for (const company of companies) {
    const tx = await factory.listCompany(
      company.name,
      company.ticker,
      company.sector,
      company.supply
    );
    await tx.wait();

    const tokenAddr = await factory.getTokenAddress(company.ticker);
    tokenAddresses[company.ticker] = tokenAddr;
    console.log(`   ✅ ${company.ticker.padEnd(6)} → ${tokenAddr}`);
  }
  console.log();

  // ─── 5. Create Liquidity Pools ────────────────────────────────────────────
  console.log("5️⃣  Creating AMM liquidity pools...");

  const poolAddresses = {};

  for (const company of companies) {
    const tx = await exchange.createPool(company.ticker);
    await tx.wait();

    const tokenAddr = tokenAddresses[company.ticker];
    const poolAddr  = await exchange.getPool(tokenAddr);
    poolAddresses[company.ticker] = poolAddr;
    console.log(`   ✅ ${company.ticker.padEnd(6)} pool → ${poolAddr}`);
  }
  console.log();

  // ─── 6. Register Tickers on Oracle ───────────────────────────────────────
  console.log("6️⃣  Registering tickers on PSXOracle...");
  const tickers = companies.map(c => c.ticker);
  const regTx   = await oracle.registerTickers(tickers);
  await regTx.wait();
  console.log(`   ✅ Registered: ${tickers.join(", ")}\n`);

  // ─── 7. Authorize Feeder Wallet ───────────────────────────────────────────
  console.log("7️⃣  Authorizing oracle feeder wallet...");

  // Feeder wallet comes from FEEDER_PRIVATE_KEY in .env
  // Falls back to deployer if not set (fine for local testing)
  let feederAddress;
  if (process.env.FEEDER_PRIVATE_KEY) {
    const feederWallet = new ethers.Wallet(process.env.FEEDER_PRIVATE_KEY);
    feederAddress = feederWallet.address;
  } else {
    feederAddress = deployer.address;
    console.log("   ⚠️  FEEDER_PRIVATE_KEY not set — using deployer as feeder");
  }

  const feederTx = await oracle.setFeeder(feederAddress, true);
  await feederTx.wait();
  console.log(`   ✅ Feeder authorized: ${feederAddress}\n`);

  // ─── 8. Print Summary ─────────────────────────────────────────────────────
  console.log("===========================================");
  console.log("           DEPLOYMENT COMPLETE             ");
  console.log("===========================================");

  console.log("\n📋 Core Contracts (paste these into your .env files):\n");
  console.log(`FACTORY_ADDRESS=${factoryAddr}`);
  console.log(`EXCHANGE_ADDRESS=${exchangeAddr}`);
  console.log(`ORACLE_ADDRESS=${oracleAddr}`);

  console.log("\n📋 Frontend .env (paste into frontend/.env):\n");
  console.log(`VITE_FACTORY_ADDRESS=${factoryAddr}`);
  console.log(`VITE_EXCHANGE_ADDRESS=${exchangeAddr}`);
  console.log(`VITE_ORACLE_ADDRESS=${oracleAddr}`);

  console.log("\n📦 Token Addresses:\n");
  for (const [ticker, addr] of Object.entries(tokenAddresses)) {
    console.log(`  ${ticker.padEnd(6)} : ${addr}`);
  }

  console.log("\n🌊 Pool Addresses:\n");
  for (const [ticker, addr] of Object.entries(poolAddresses)) {
    console.log(`  ${ticker.padEnd(6)} : ${addr}`);
  }

  console.log("\n⚠️  Next steps:");
  console.log("  1. Copy the .env values above into psx/.env and psx/frontend/.env");
  console.log("  2. Seed pools with liquidity before trading");
  console.log("  3. Start the oracle feeder: cd oracle && python oracle_feeder.py");
  console.log();

  // ─── 9. Verify on Etherscan (Sepolia only) ────────────────────────────────
  if (network.name === "sepolia") {
    console.log("⏳ Waiting 30 seconds before Etherscan verification...");
    await new Promise(resolve => setTimeout(resolve, 30000));

    console.log("\n🔍 Verifying contracts on Etherscan...");

    const toVerify = [
      { name: "PSXTokenFactory", address: factoryAddr,  args: []            },
      { name: "PSXExchange",     address: exchangeAddr, args: [factoryAddr] },
      { name: "PSXOracle",       address: oracleAddr,   args: []            },
    ];

    for (const contract of toVerify) {
      try {
        await hre.run("verify:verify", {
          address: contract.address,
          constructorArguments: contract.args,
        });
        console.log(`   ✅ ${contract.name} verified`);
      } catch (err) {
        // "Already verified" is not a real error
        if (err.message.includes("Already Verified")) {
          console.log(`   ✅ ${contract.name} already verified`);
        } else {
          console.log(`   ⚠️  ${contract.name} verification failed: ${err.message}`);
        }
      }
    }
  }

  console.log("\n✅ All done!\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });