// test/06_Integration.test.js
//
// Full end-to-end simulation of the PSX platform:
//   Admin lists company → creates pool → seeds liquidity
//   Feeder pushes real price → Investor buys shares → LP provides liquidity
//   Investor sells shares → Admin withdraws fees → LP removes liquidity
//
const { expect }              = require("chai");
const { ethers }              = require("hardhat");
const { loadFixture }         = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployAll, shares, eth, pkr } = require("./helpers");

describe("Integration — Full Investor Journey", function () {

  async function fixture() {
    return deployAll();
  }

  it("complete buy → hold → sell cycle works correctly", async function () {
    const { admin, feeder, alice, bob, factory, exchange, oracle, tokens, pools } =
      await loadFixture(fixture);

    const ogdc     = tokens["OGDC"];
    const pool     = pools["OGDC"];
    const ogdcAddr = await ogdc.getAddress();
    const exchAddr = await exchange.getAddress();

    // ── Step 1: Feeder pushes real OGDC price ─────────────────────────────
    await oracle.connect(feeder).updatePrice("OGDC", pkr(182.50));
    const [oraclePrice, isFresh] = await oracle.getPrice("OGDC");
    expect(isFresh).to.be.true;
    expect(oraclePrice).to.equal(pkr(182.50));

    // ── Step 2: Admin seeds liquidity into OGDC pool ──────────────────────
    //    10 ETH + 10,000 tokens → initial price: 0.001 ETH/token
    const seedETH    = eth(10);
    const seedTokens = shares(10_000);

    await ogdc.connect(admin).approve(exchAddr, seedTokens);
    await exchange.connect(admin).addLiquidity(ogdcAddr, seedTokens, 0n, {
      value: seedETH,
    });

    const [ethRes, tokenRes] = await pool.getReserves();
    expect(ethRes).to.equal(seedETH);
    expect(tokenRes).to.equal(seedTokens);

    // ── Step 3: Alice (investor) buys OGDC shares ─────────────────────────
    await ogdc.connect(admin).setWhitelist(alice.address, true);

    const aliceTokensBefore = await ogdc.balanceOf(alice.address);
    await exchange.connect(alice).buyShares(ogdcAddr, 0n, { value: eth(1) });
    const aliceTokensAfter  = await ogdc.balanceOf(alice.address);
    const alicePurchased    = aliceTokensAfter - aliceTokensBefore;

    expect(alicePurchased).to.be.gt(0n);
    console.log(`    Alice bought: ${ethers.formatEther(alicePurchased)} OGDC`);

    // ── Step 4: Bob (LP) adds liquidity ───────────────────────────────────
    await ogdc.connect(admin).mint(bob.address, shares(500));
    await ogdc.connect(admin).setWhitelist(bob.address, true);

    await ogdc.connect(bob).approve(exchAddr, shares(500));
    await exchange.connect(bob).addLiquidity(ogdcAddr, shares(500), 0n, {
      value: eth(0.5),
    });

    const bobLP = await pool.balanceOf(bob.address);
    expect(bobLP).to.be.gt(0n);
    console.log(`    Bob's LP tokens: ${ethers.formatEther(bobLP)}`);

    // ── Step 5: Alice sells half her shares ───────────────────────────────
    const aliceSells = alicePurchased / 2n;
    await ogdc.connect(alice).approve(exchAddr, aliceSells);

    const aliceEthBefore = await ethers.provider.getBalance(alice.address);
    const tx = await exchange.connect(alice).sellShares(ogdcAddr, aliceSells, 0n);
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed * receipt.gasPrice;
    const aliceEthAfter = await ethers.provider.getBalance(alice.address);

    const ethReceived = aliceEthAfter + gasUsed - aliceEthBefore;
    expect(ethReceived).to.be.gt(0n);
    console.log(`    Alice received: ${ethers.formatEther(ethReceived)} ETH from sale`);

    // ── Step 6: Platform fee has accumulated ─────────────────────────────
    const platformFee = await exchange.platformFeeBalance();
    expect(platformFee).to.be.gt(0n);
    console.log(`    Platform fee:   ${ethers.formatEther(platformFee)} ETH`);

    // ── Step 7: Admin withdraws fees ──────────────────────────────────────
    await exchange.connect(admin).withdrawPlatformFees(admin.address);
    expect(await exchange.platformFeeBalance()).to.equal(0n);

    // ── Step 8: Bob removes his liquidity ─────────────────────────────────
    await pool.connect(bob).approve(exchAddr, bobLP);
    await exchange.connect(bob).removeLiquidity(ogdcAddr, bobLP, 0n, 0n);

    expect(await pool.balanceOf(bob.address)).to.equal(0n);
    console.log(`    Bob removed liquidity — LP balance: 0`);

    // ── Step 9: Pool still has admin's liquidity remaining ────────────────
    const [finalETH, finalTokens] = await pool.getReserves();
    expect(finalETH).to.be.gt(0n);
    expect(finalTokens).to.be.gt(0n);
    console.log(`    Pool reserves — ETH: ${ethers.formatEther(finalETH)}, Tokens: ${ethers.formatEther(finalTokens)}`);
  });

  it("three traders buying sequentially raises the price (AMM price impact)", async function () {
    const { admin, tokens, exchange, pools } = await loadFixture(fixture);

    const ogdc     = tokens["OGDC"];
    const pool     = pools["OGDC"];
    const ogdcAddr = await ogdc.getAddress();
    const exchAddr = await exchange.getAddress();
    const signers  = await ethers.getSigners();

    // Seed pool
    await ogdc.connect(admin).approve(exchAddr, shares(10_000));
    await exchange.connect(admin).addLiquidity(ogdcAddr, shares(10_000), 0n, {
      value: eth(10),
    });

    const traders = [signers[5], signers[6], signers[7]];
    for (const trader of traders) {
      await ogdc.connect(admin).setWhitelist(trader.address, true);
    }

    // Record price before trades
    const priceBefore = await pool.tokenPriceInETH();

    // Three sequential buys — each one raises the price
    for (const trader of traders) {
      await exchange.connect(trader).buyShares(ogdcAddr, 0n, { value: eth(2) });
    }

    const priceAfter = await pool.tokenPriceInETH();

    // After buys, ETH reserve grows → token reserve shrinks → price rises
    // tokenPriceInETH = reserveToken / reserveETH * 1e18
    // After buys: more ETH, fewer tokens → ratio goes DOWN (fewer tokens per ETH)
    // which means each token is WORTH more ETH → price per token in ETH went up
    expect(priceAfter).to.be.lt(priceBefore); // fewer tokens per ETH = higher per-token ETH price
    console.log(`    Price before: ${priceBefore}, after: ${priceAfter}`);
  });

  it("admin can list a new company mid-session and it works immediately", async function () {
    const { admin, alice, factory, exchange, tokens } = await loadFixture(fixture);

    // List a brand new company
    await factory.connect(admin).listCompany("Engro Corporation", "ENGRO", "Fertilizer", 200_000n);
    const engroAddr = await factory.getTokenAddress("ENGRO");
    const engro = await ethers.getContractAt("PSXToken", engroAddr);

    // Create pool
    await exchange.connect(admin).createPool("ENGRO");

    // Seed liquidity
    const exchAddr = await exchange.getAddress();
    await engro.connect(admin).approve(exchAddr, shares(2_000));
    await exchange.connect(admin).addLiquidity(engroAddr, shares(2_000), 0n, {
      value: eth(2),
    });

    // Alice buys
    await engro.connect(admin).setWhitelist(alice.address, true);
    await exchange.connect(alice).buyShares(engroAddr, 0n, { value: eth(0.5) });

    expect(await engro.balanceOf(alice.address)).to.be.gt(0n);
  });
});
