// test/04_PSXExchange.test.js
const { expect }              = require("chai");
const { ethers }              = require("hardhat");
const { loadFixture }         = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployAll, whitelistOn, shares, eth } = require("./helpers");

describe("PSXExchange", function () {

  // ─── Fixture ──────────────────────────────────────────────────────────────

  async function fixture() {
    const ctx = await deployAll();
    const { admin, exchange, tokens } = ctx;

    const ogdc      = tokens["OGDC"];
    const hbl       = tokens["HBL"];
    const exchAddr  = await exchange.getAddress();

    // Seed OGDC pool: 10 ETH + 10,000 tokens → price = 0.001 ETH/token
    await ogdc.connect(admin).approve(exchAddr, shares(10_000));
    await exchange.connect(admin).addLiquidity(
      await ogdc.getAddress(), shares(10_000), 0n, { value: eth(10) }
    );

    // Seed HBL pool: 5 ETH + 5,000 tokens → same price
    await hbl.connect(admin).approve(exchAddr, shares(5_000));
    await exchange.connect(admin).addLiquidity(
      await hbl.getAddress(), shares(5_000), 0n, { value: eth(5) }
    );

    return { ...ctx, ogdc, hbl, exchAddr };
  }

  // ─── Pool Creation ────────────────────────────────────────────────────────

  describe("createPool()", function () {
    it("creates pool for a listed company", async function () {
      const { exchange, tokens } = await loadFixture(fixture);
      const addr = await exchange.getPool(await tokens["OGDC"].getAddress());
      expect(addr).to.not.equal(ethers.ZeroAddress);
    });

    it("reverts if pool already exists", async function () {
      const { exchange, admin } = await loadFixture(fixture);
      await expect(
        exchange.connect(admin).createPool("OGDC")
      ).to.be.revertedWith("Exchange: pool already exists");
    });

    it("reverts for unknown ticker", async function () {
      const { exchange, admin } = await loadFixture(fixture);
      await expect(
        exchange.connect(admin).createPool("FAKE")
      ).to.be.revertedWith("Exchange: ticker not listed on factory");
    });

    it("reverts if company is delisted", async function () {
      const { exchange, factory, admin } = await loadFixture(fixture);
      await factory.connect(admin).listCompany("Delisted Corp", "DEL", "Other", 100n);
      await factory.connect(admin).delistCompany("DEL");

      await expect(
        exchange.connect(admin).createPool("DEL")
      ).to.be.revertedWith("Exchange: company is delisted");
    });

    it("non-admin cannot create pool", async function () {
      const { exchange, factory, admin, alice } = await loadFixture(fixture);
      await factory.connect(admin).listCompany("New Corp", "NEW", "Tech", 100n);
      await expect(
        exchange.connect(alice).createPool("NEW")
      ).to.be.revertedWith("Exchange: caller is not admin");
    });

    it("emits PoolCreated event", async function () {
      const { exchange, factory, admin } = await loadFixture(fixture);
      await factory.connect(admin).listCompany("Emit Corp", "EMIT", "Tech", 1000n);
      await expect(exchange.connect(admin).createPool("EMIT"))
        .to.emit(exchange, "PoolCreated");
    });
  });

  // ─── Add Liquidity ────────────────────────────────────────────────────────

  describe("addLiquidity()", function () {
    it("reverts with no ETH sent", async function () {
      const { exchange, ogdc } = await loadFixture(fixture);
      await expect(
        exchange.addLiquidity(await ogdc.getAddress(), shares(100), 0n, { value: 0n })
      ).to.be.revertedWith("Exchange: must send ETH");
    });

    it("reverts with zero token amount", async function () {
      const { exchange, ogdc } = await loadFixture(fixture);
      await expect(
        exchange.addLiquidity(await ogdc.getAddress(), 0n, 0n, { value: eth(1) })
      ).to.be.revertedWith("Exchange: token amount must be > 0");
    });

    it("reverts for unknown pool", async function () {
      const { exchange } = await loadFixture(fixture);
      const fakeToken = ethers.Wallet.createRandom().address;
      await expect(
        exchange.addLiquidity(fakeToken, shares(100), 0n, { value: eth(1) })
      ).to.be.revertedWith("Exchange: no pool for this token");
    });

    it("emits LiquidityAdded event", async function () {
      const { exchange, ogdc, admin, exchAddr } = await loadFixture(fixture);
      await ogdc.connect(admin).approve(exchAddr, shares(100));
      await expect(
        exchange.connect(admin).addLiquidity(
          await ogdc.getAddress(), shares(100), 0n, { value: eth(0.1) }
        )
      ).to.emit(exchange, "LiquidityAdded");
    });
  });

  // ─── Buy Shares ───────────────────────────────────────────────────────────

  describe("buyShares()", function () {
    it("reverts with no ETH sent", async function () {
      const { exchange, ogdc } = await loadFixture(fixture);
      await expect(
        exchange.buyShares(await ogdc.getAddress(), 0n, { value: 0n })
      ).to.be.revertedWith("Exchange: must send ETH to buy");
    });

    it("reverts for unknown pool", async function () {
      const { exchange } = await loadFixture(fixture);
      const fakeToken = ethers.Wallet.createRandom().address;
      await expect(
        exchange.buyShares(fakeToken, 0n, { value: eth(1) })
      ).to.be.revertedWith("Exchange: no pool for this token");
    });

    it("delivers tokens to buyer", async function () {
      const { exchange, ogdc, admin, alice } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);

      const before = await ogdc.balanceOf(alice.address);
      await exchange.connect(alice).buyShares(await ogdc.getAddress(), 0n, { value: eth(1) });
      const after = await ogdc.balanceOf(alice.address);

      expect(after).to.be.gt(before);
    });

    it("emits SharesBought event", async function () {
      const { exchange, ogdc, admin, alice } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);

      await expect(
        exchange.connect(alice).buyShares(await ogdc.getAddress(), 0n, { value: eth(1) })
      ).to.emit(exchange, "SharesBought");
    });

    it("platform fee is accumulated", async function () {
      const { exchange, ogdc, admin, alice } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);

      const feeBefore = await exchange.platformFeeBalance();
      await exchange.connect(alice).buyShares(await ogdc.getAddress(), 0n, { value: eth(1) });
      const feeAfter = await exchange.platformFeeBalance();

      expect(feeAfter).to.be.gt(feeBefore);
    });
  });

  // ─── Sell Shares ──────────────────────────────────────────────────────────

  describe("sellShares()", function () {
    it("reverts with zero token amount", async function () {
      const { exchange, ogdc } = await loadFixture(fixture);
      await expect(
        exchange.sellShares(await ogdc.getAddress(), 0n, 0n)
      ).to.be.revertedWith("Exchange: token amount must be > 0");
    });

    it("reverts without allowance", async function () {
      const { exchange, ogdc, admin, alice } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);
      await ogdc.connect(admin).mint(alice.address, shares(100));
      // No approve

      await expect(
        exchange.connect(alice).sellShares(await ogdc.getAddress(), shares(100), 0n)
      ).to.be.reverted;
    });

    it("seller receives ETH", async function () {
      const { exchange, ogdc, admin, alice, exchAddr } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);
      await ogdc.connect(admin).mint(alice.address, shares(100));
      await ogdc.connect(alice).approve(exchAddr, shares(100));

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await exchange.connect(alice).sellShares(
        await ogdc.getAddress(), shares(100), 0n
      );
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);

      // after + gas > before means they received more ETH than gas cost
      expect(after + gasUsed).to.be.gt(before);
    });

    it("emits SharesSold event", async function () {
      const { exchange, ogdc, admin, alice, exchAddr } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);
      await ogdc.connect(admin).mint(alice.address, shares(100));
      await ogdc.connect(alice).approve(exchAddr, shares(100));

      await expect(
        exchange.connect(alice).sellShares(await ogdc.getAddress(), shares(100), 0n)
      ).to.emit(exchange, "SharesSold");
    });
  });

  // ─── Platform Fee ─────────────────────────────────────────────────────────

  describe("Platform fees", function () {
    it("admin can withdraw accumulated fees", async function () {
      const { exchange, ogdc, admin, alice } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);

      // Generate some fees
      await exchange.connect(alice).buyShares(await ogdc.getAddress(), 0n, { value: eth(2) });

      const feeBal = await exchange.platformFeeBalance();
      expect(feeBal).to.be.gt(0n);

      const before = await ethers.provider.getBalance(admin.address);
      const tx = await exchange.connect(admin).withdrawPlatformFees(admin.address);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(admin.address);

      expect(after + gasUsed).to.be.gt(before);
      expect(await exchange.platformFeeBalance()).to.equal(0n);
    });

    it("reverts if no fees to withdraw", async function () {
      const { exchange, admin } = await loadFixture(fixture);
      await expect(
        exchange.connect(admin).withdrawPlatformFees(admin.address)
      ).to.be.revertedWith("Exchange: no fees to withdraw");
    });

    it("non-admin cannot withdraw fees", async function () {
      const { exchange, ogdc, admin, alice } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);
      await exchange.connect(alice).buyShares(await ogdc.getAddress(), 0n, { value: eth(1) });

      await expect(
        exchange.connect(alice).withdrawPlatformFees(alice.address)
      ).to.be.revertedWith("Exchange: caller is not admin");
    });

    it("emits PlatformFeeWithdrawn event", async function () {
      const { exchange, ogdc, admin, alice } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);
      await exchange.connect(alice).buyShares(await ogdc.getAddress(), 0n, { value: eth(1) });

      await expect(exchange.connect(admin).withdrawPlatformFees(admin.address))
        .to.emit(exchange, "PlatformFeeWithdrawn");
    });
  });

  // ─── Multi-Token ──────────────────────────────────────────────────────────

  describe("Multi-token support", function () {
    it("two tokens have independent pools with separate reserves", async function () {
      const { exchange, ogdc, hbl } = await loadFixture(fixture);

      const [ogdcETH]  = await exchange.getReserves(await ogdc.getAddress());
      const [hblETH]   = await exchange.getReserves(await hbl.getAddress());

      expect(ogdcETH).to.equal(eth(10));
      expect(hblETH).to.equal(eth(5));
    });

    it("buying one token does not affect the other pool", async function () {
      const { exchange, ogdc, hbl, admin, alice } = await loadFixture(fixture);
      await ogdc.connect(admin).setWhitelist(alice.address, true);

      const [hblEthBefore] = await exchange.getReserves(await hbl.getAddress());
      await exchange.connect(alice).buyShares(await ogdc.getAddress(), 0n, { value: eth(1) });
      const [hblEthAfter]  = await exchange.getReserves(await hbl.getAddress());

      expect(hblEthAfter).to.equal(hblEthBefore);
    });

    it("totalPools returns correct count", async function () {
      const { exchange } = await loadFixture(fixture);
      expect(await exchange.totalPools()).to.equal(3n);
    });
  });

  // ─── Admin Transfer ───────────────────────────────────────────────────────

  describe("transferAdmin()", function () {
    it("transfers admin role", async function () {
      const { exchange, admin, alice } = await loadFixture(fixture);
      await exchange.connect(admin).transferAdmin(alice.address);
      expect(await exchange.admin()).to.equal(alice.address);
    });

    it("old admin loses privileges after transfer", async function () {
      const { exchange, admin, alice } = await loadFixture(fixture);
      await exchange.connect(admin).transferAdmin(alice.address);

      await expect(
        exchange.connect(admin).withdrawPlatformFees(admin.address)
      ).to.be.revertedWith("Exchange: caller is not admin");
    });
  });
});
