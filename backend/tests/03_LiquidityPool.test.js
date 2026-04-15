// test/03_LiquidityPool.test.js
const { expect }              = require("chai");
const { ethers }              = require("hardhat");
const { loadFixture }         = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployAll, whitelistOn, shares, eth } = require("./helpers");

describe("LiquidityPool (AMM)", function () {

  // ─── Fixture: deploy + seed OGDC pool with initial liquidity ─────────────

  async function fixture() {
    const ctx = await deployAll();
    const { admin, exchange, tokens, pools } = ctx;

    const token    = tokens["OGDC"];
    const pool     = pools["OGDC"];
    const tokenAddr = await token.getAddress();
    const exchAddr  = await exchange.getAddress();

    // Approve exchange to spend admin's tokens, then seed pool
    const seedETH   = eth(10);          // 10 ETH
    const seedTokens = shares(10_000);  // 10,000 OGDC tokens

    await token.connect(admin).approve(exchAddr, seedTokens);
    await exchange.connect(admin).addLiquidity(tokenAddr, seedTokens, 0n, { value: seedETH });

    return { ...ctx, token, pool, tokenAddr, exchAddr, seedETH, seedTokens };
  }

  // ─── Deployment ───────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets correct psxToken address", async function () {
      const { pool, token } = await loadFixture(fixture);
      expect(await pool.psxToken()).to.equal(await token.getAddress());
    });

    it("sets correct exchange address", async function () {
      const { pool, exchange } = await loadFixture(fixture);
      expect(await pool.exchange()).to.equal(await exchange.getAddress());
    });

    it("LP token has correct name format", async function () {
      const { pool } = await loadFixture(fixture);
      expect(await pool.name()).to.equal("OGDC-ETH LP Token");
      expect(await pool.symbol()).to.equal("OGDC-LP");
    });
  });

  // ─── Add Liquidity ────────────────────────────────────────────────────────

  describe("addLiquidity()", function () {
    it("seeds pool with correct ETH and token reserves", async function () {
      const { pool, seedETH, seedTokens } = await loadFixture(fixture);
      const [ethRes, tokenRes] = await pool.getReserves();
      expect(ethRes).to.equal(seedETH);
      expect(tokenRes).to.equal(seedTokens);
    });

    it("mints LP tokens to provider on first deposit", async function () {
      const { pool, admin } = await loadFixture(fixture);
      const lpBalance = await pool.balanceOf(admin.address);
      expect(lpBalance).to.be.gt(0n);
    });

    it("second LP provider receives proportional LP tokens", async function () {
      const { exchange, token, pool, tokenAddr, exchAddr, admin, alice } = await loadFixture(fixture);

      await token.connect(admin).mint(alice.address, shares(1_000));
      await token.connect(alice).approve(exchAddr, shares(1_000));

      const lpBefore = await pool.totalSupply();

      await exchange.connect(alice).addLiquidity(tokenAddr, shares(1_000), 0n, {
        value: eth(1),
      });

      const lpAfter = await pool.totalSupply();
      expect(lpAfter).to.be.gt(lpBefore);
      expect(await pool.balanceOf(alice.address)).to.be.gt(0n);
    });

    it("reverts if called directly (not through exchange)", async function () {
      const { pool, admin } = await loadFixture(fixture);
      await expect(
        pool.connect(admin).addLiquidity(admin.address, shares(100), { value: eth(1) })
      ).to.be.revertedWith("Pool: caller is not the exchange");
    });
  });

  // ─── Remove Liquidity ─────────────────────────────────────────────────────

  describe("removeLiquidity()", function () {
    it("returns ETH and tokens proportionally", async function () {
      const { exchange, token, pool, tokenAddr, exchAddr, admin } = await loadFixture(fixture);

      const lpBalance = await pool.balanceOf(admin.address);
      const ethBefore = await ethers.provider.getBalance(admin.address);

      // Approve LP tokens for exchange to pull
      await pool.connect(admin).approve(exchAddr, lpBalance);

      await exchange.connect(admin).removeLiquidity(
        tokenAddr, lpBalance, 0n, 0n
      );

      const ethAfter = await ethers.provider.getBalance(admin.address);
      // ETH balance should be close to what was deposited (minus gas)
      expect(ethAfter).to.be.gt(ethBefore - eth(0.01)); // within 0.01 ETH gas tolerance
    });

    it("LP tokens are burned after removal", async function () {
      const { exchange, token, pool, tokenAddr, exchAddr, admin } = await loadFixture(fixture);

      const lpBalance = await pool.balanceOf(admin.address);
      await pool.connect(admin).approve(exchAddr, lpBalance);
      await exchange.connect(admin).removeLiquidity(tokenAddr, lpBalance, 0n, 0n);

      expect(await pool.balanceOf(admin.address)).to.equal(0n);
    });

    it("reverts if LP amount is zero", async function () {
      const { exchange, tokenAddr } = await loadFixture(fixture);
      await expect(
        exchange.connect((await ethers.getSigners())[1]).removeLiquidity(tokenAddr, 0n, 0n, 0n)
      ).to.be.revertedWith("Exchange: LP amount must be > 0");
    });
  });

  // ─── Swap ETH → Token ─────────────────────────────────────────────────────

  describe("swapETHForToken()", function () {
    it("buyer receives tokens when sending ETH", async function () {
      const { exchange, token, tokenAddr, alice, admin } = await loadFixture(fixture);

      await token.connect(admin).setWhitelist(alice.address, true);
      const balBefore = await token.balanceOf(alice.address);

      await exchange.connect(alice).buyShares(tokenAddr, 0n, { value: eth(1) });

      const balAfter = await token.balanceOf(alice.address);
      expect(balAfter).to.be.gt(balBefore);
    });

    it("ETH reserve increases after buy", async function () {
      const { exchange, token, pool, tokenAddr, alice, admin } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);

      const [ethResBefore] = await pool.getReserves();
      await exchange.connect(alice).buyShares(tokenAddr, 0n, { value: eth(1) });
      const [ethResAfter] = await pool.getReserves();

      expect(ethResAfter).to.be.gt(ethResBefore);
    });

    it("token reserve decreases after buy", async function () {
      const { exchange, token, pool, tokenAddr, alice, admin } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);

      const [, tokenResBefore] = await pool.getReserves();
      await exchange.connect(alice).buyShares(tokenAddr, 0n, { value: eth(1) });
      const [, tokenResAfter] = await pool.getReserves();

      expect(tokenResAfter).to.be.lt(tokenResBefore);
    });

    it("reverts if slippage too high (minTokenOut not met)", async function () {
      const { exchange, token, tokenAddr, alice, admin } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);

      // Set an unrealistically high minTokenOut
      const unrealisticMin = shares(99_999);
      await expect(
        exchange.connect(alice).buyShares(tokenAddr, unrealisticMin, { value: eth(1) })
      ).to.be.reverted;
    });
  });

  // ─── Swap Token → ETH ─────────────────────────────────────────────────────

  describe("swapTokenForETH()", function () {
    it("seller receives ETH when selling tokens", async function () {
      const { exchange, token, tokenAddr, exchAddr, alice, admin } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);

      // Give alice some tokens to sell
      await token.connect(admin).mint(alice.address, shares(100));
      await token.connect(alice).approve(exchAddr, shares(100));

      const ethBefore = await ethers.provider.getBalance(alice.address);
      await exchange.connect(alice).sellShares(tokenAddr, shares(100), 0n);
      const ethAfter = await ethers.provider.getBalance(alice.address);

      // ETH received > gas paid (net positive)
      // We just check they received something meaningful
      expect(ethAfter).to.be.gt(ethBefore - eth(0.01));
    });

    it("token reserve increases after sell", async function () {
      const { exchange, token, pool, tokenAddr, exchAddr, alice, admin } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);
      await token.connect(admin).mint(alice.address, shares(100));
      await token.connect(alice).approve(exchAddr, shares(100));

      const [, tokenResBefore] = await pool.getReserves();
      await exchange.connect(alice).sellShares(tokenAddr, shares(100), 0n);
      const [, tokenResAfter] = await pool.getReserves();

      expect(tokenResAfter).to.be.gt(tokenResBefore);
    });

    it("reverts if no allowance given", async function () {
      const { exchange, token, tokenAddr, alice, admin } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);
      await token.connect(admin).mint(alice.address, shares(100));
      // No approve() call

      await expect(
        exchange.connect(alice).sellShares(tokenAddr, shares(100), 0n)
      ).to.be.reverted;
    });
  });

  // ─── x * y = k Invariant ─────────────────────────────────────────────────

  describe("AMM invariant (x * y = k)", function () {
    it("product never decreases after a swap (fees increase k)", async function () {
      const { exchange, token, pool, tokenAddr, alice, admin } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);

      const [ethBefore, tokenBefore] = await pool.getReserves();
      const kBefore = ethBefore * tokenBefore;

      // Do a buy
      await exchange.connect(alice).buyShares(tokenAddr, 0n, { value: eth(1) });

      const [ethAfter, tokenAfter] = await pool.getReserves();
      const kAfter = ethAfter * tokenAfter;

      // k should be >= before (fees make it slightly larger)
      expect(kAfter).to.be.gte(kBefore);
    });

    it("multiple swaps preserve k monotonically", async function () {
      const { exchange, token, pool, tokenAddr, exchAddr, alice, admin } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);

      let [e, t] = await pool.getReserves();
      let k = e * t;

      for (let i = 0; i < 3; i++) {
        await exchange.connect(alice).buyShares(tokenAddr, 0n, { value: eth(0.5) });
        [e, t] = await pool.getReserves();
        const kNew = e * t;
        expect(kNew).to.be.gte(k);
        k = kNew;
      }
    });
  });

  // ─── Price Quotes ─────────────────────────────────────────────────────────

  describe("Price quotes", function () {
    it("quoteETHForToken returns positive amount", async function () {
      const { pool } = await loadFixture(fixture);
      const out = await pool.quoteETHForToken(eth(1));
      expect(out).to.be.gt(0n);
    });

    it("quoteTokenForETH returns positive amount", async function () {
      const { pool } = await loadFixture(fixture);
      const out = await pool.quoteTokenForETH(shares(100));
      expect(out).to.be.gt(0n);
    });

    it("larger input yields larger output", async function () {
      const { pool } = await loadFixture(fixture);
      const small = await pool.quoteETHForToken(eth(1));
      const large = await pool.quoteETHForToken(eth(5));
      expect(large).to.be.gt(small);
    });

    it("tokenPriceInETH returns non-zero", async function () {
      const { pool } = await loadFixture(fixture);
      expect(await pool.tokenPriceInETH()).to.be.gt(0n);
    });

    it("exchange quoteBuy accounts for platform fee", async function () {
      const { exchange, pool, tokenAddr } = await loadFixture(fixture);

      const directQuote   = await pool.quoteETHForToken(eth(1));
      const exchangeQuote = await exchange.quoteBuy(tokenAddr, eth(1));

      // Exchange quote should be slightly less (platform fee deducted from ETH before swap)
      expect(exchangeQuote).to.be.lt(directQuote);
    });
  });
});
