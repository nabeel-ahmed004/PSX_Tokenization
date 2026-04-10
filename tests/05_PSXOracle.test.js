// test/05_PSXOracle.test.js
const { expect }              = require("chai");
const { ethers }              = require("hardhat");
const { loadFixture }         = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { time }                = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployAll, pkr }      = require("./helpers");

describe("PSXOracle", function () {

  async function fixture() {
    return deployAll();
  }

  // ─── Initial State ────────────────────────────────────────────────────────

  describe("Initial state", function () {
    it("sets deployer as admin", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      expect(await oracle.admin()).to.equal(admin.address);
    });

    it("admin is also a feeder by default", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      expect(await oracle.isFeeder(admin.address)).to.be.true;
    });

    it("registers the 3 sample tickers", async function () {
      const { oracle } = await loadFixture(fixture);
      const tickers = await oracle.getAllTickers();
      expect(tickers).to.include("OGDC");
      expect(tickers).to.include("HBL");
      expect(tickers).to.include("PSO");
    });

    it("default staleness threshold is 10 minutes", async function () {
      const { oracle } = await loadFixture(fixture);
      expect(await oracle.stalenessThreshold()).to.equal(600n); // 600 seconds
    });
  });

  // ─── Ticker Registration ──────────────────────────────────────────────────

  describe("registerTicker()", function () {
    it("admin can register a new ticker", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      await oracle.connect(admin).registerTicker("LUCK");
      expect(await oracle.tickerExists("LUCK")).to.be.true;
    });

    it("reverts on duplicate ticker", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      await expect(
        oracle.connect(admin).registerTicker("OGDC")
      ).to.be.revertedWith("Oracle: ticker already registered");
    });

    it("non-admin cannot register", async function () {
      const { oracle, alice } = await loadFixture(fixture);
      await expect(
        oracle.connect(alice).registerTicker("NEW")
      ).to.be.revertedWith("Oracle: caller is not admin");
    });

    it("emits TickerRegistered event", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      await expect(oracle.connect(admin).registerTicker("ENGRO"))
        .to.emit(oracle, "TickerRegistered")
        .withArgs("ENGRO");
    });

    it("batch register works for multiple tickers", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      await oracle.connect(admin).registerTickers(["MCB", "UBL", "PPL"]);
      expect(await oracle.tickerExists("MCB")).to.be.true;
      expect(await oracle.tickerExists("UBL")).to.be.true;
      expect(await oracle.tickerExists("PPL")).to.be.true;
    });

    it("batch register skips already-registered tickers silently", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      // OGDC already registered — should not revert
      await expect(
        oracle.connect(admin).registerTickers(["OGDC", "MCB"])
      ).to.not.be.reverted;
    });
  });

  // ─── Feeder Management ────────────────────────────────────────────────────

  describe("setFeeder()", function () {
    it("admin can authorize a feeder", async function () {
      const { oracle, admin, alice } = await loadFixture(fixture);
      await oracle.connect(admin).setFeeder(alice.address, true);
      expect(await oracle.isFeeder(alice.address)).to.be.true;
    });

    it("admin can revoke a feeder", async function () {
      const { oracle, admin, feeder } = await loadFixture(fixture);
      await oracle.connect(admin).setFeeder(feeder.address, false);
      expect(await oracle.isFeeder(feeder.address)).to.be.false;
    });

    it("reverts on zero address", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      await expect(
        oracle.connect(admin).setFeeder(ethers.ZeroAddress, true)
      ).to.be.revertedWith("Oracle: invalid address");
    });

    it("emits FeederUpdated event", async function () {
      const { oracle, admin, alice } = await loadFixture(fixture);
      await expect(oracle.connect(admin).setFeeder(alice.address, true))
        .to.emit(oracle, "FeederUpdated")
        .withArgs(alice.address, true);
    });
  });

  // ─── updatePrice ──────────────────────────────────────────────────────────

  describe("updatePrice()", function () {
    it("feeder can update a registered ticker", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await oracle.connect(feeder).updatePrice("OGDC", pkr(182.50));

      const [price] = await oracle.getLatestPrice("OGDC");
      expect(price).to.equal(pkr(182.50));
    });

    it("increments roundId on each update", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await oracle.connect(feeder).updatePrice("OGDC", pkr(180));
      await oracle.connect(feeder).updatePrice("OGDC", pkr(181));
      await oracle.connect(feeder).updatePrice("OGDC", pkr(182));

      const [, , roundId] = await oracle.getLatestPrice("OGDC");
      expect(roundId).to.equal(3n);
    });

    it("stores historical price by roundId", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await oracle.connect(feeder).updatePrice("OGDC", pkr(180));
      await oracle.connect(feeder).updatePrice("OGDC", pkr(185));

      const round1Price = await oracle.getHistoricalPrice("OGDC", 1n);
      const round2Price = await oracle.getHistoricalPrice("OGDC", 2n);

      expect(round1Price).to.equal(pkr(180));
      expect(round2Price).to.equal(pkr(185));
    });

    it("reverts for unregistered ticker", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await expect(
        oracle.connect(feeder).updatePrice("FAKE", pkr(100))
      ).to.be.revertedWith("Oracle: ticker not registered");
    });

    it("reverts for zero price", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await expect(
        oracle.connect(feeder).updatePrice("OGDC", 0n)
      ).to.be.revertedWith("Oracle: price must be > 0");
    });

    it("non-feeder cannot update price", async function () {
      const { oracle, alice } = await loadFixture(fixture);
      await expect(
        oracle.connect(alice).updatePrice("OGDC", pkr(180))
      ).to.be.revertedWith("Oracle: caller is not an authorized feeder");
    });

    it("emits PriceUpdated event with correct args", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await expect(oracle.connect(feeder).updatePrice("OGDC", pkr(182.50)))
        .to.emit(oracle, "PriceUpdated")
        .withArgs("OGDC", pkr(182.50), await time.latest() + 1, 1n, feeder.address);
    });
  });

  // ─── batchUpdatePrices ────────────────────────────────────────────────────

  describe("batchUpdatePrices()", function () {
    it("updates multiple tickers in one call", async function () {
      const { oracle, feeder } = await loadFixture(fixture);

      await oracle.connect(feeder).batchUpdatePrices(
        ["OGDC",        "HBL",        "PSO"],
        [pkr(182.50),  pkr(145.30),  pkr(310.75)]
      );

      const [ogdcPrice] = await oracle.getLatestPrice("OGDC");
      const [hblPrice]  = await oracle.getLatestPrice("HBL");
      const [psoPrice]  = await oracle.getLatestPrice("PSO");

      expect(ogdcPrice).to.equal(pkr(182.50));
      expect(hblPrice).to.equal(pkr(145.30));
      expect(psoPrice).to.equal(pkr(310.75));
    });

    it("reverts on array length mismatch", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await expect(
        oracle.connect(feeder).batchUpdatePrices(
          ["OGDC", "HBL"],
          [pkr(180)]      // only 1 price for 2 tickers
        )
      ).to.be.revertedWith("Oracle: array length mismatch");
    });

    it("skips unregistered ticker without reverting", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      // FAKE is not registered — should be skipped silently
      await expect(
        oracle.connect(feeder).batchUpdatePrices(
          ["OGDC",     "FAKE"],
          [pkr(182),  pkr(999)]
        )
      ).to.not.be.reverted;

      // OGDC should still be updated
      const [ogdcPrice] = await oracle.getLatestPrice("OGDC");
      expect(ogdcPrice).to.equal(pkr(182));
    });
  });

  // ─── Staleness ────────────────────────────────────────────────────────────

  describe("Staleness", function () {
    it("price is fresh immediately after update", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await oracle.connect(feeder).updatePrice("OGDC", pkr(180));

      const [, isFresh] = await oracle.getPrice("OGDC");
      expect(isFresh).to.be.true;
    });

    it("price becomes stale after threshold", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await oracle.connect(feeder).updatePrice("OGDC", pkr(180));

      // Fast-forward 11 minutes (past 10 min threshold)
      await time.increase(11 * 60);

      const [, isFresh] = await oracle.getPrice("OGDC");
      expect(isFresh).to.be.false;
    });

    it("isStale() returns true after threshold", async function () {
      const { oracle, feeder } = await loadFixture(fixture);
      await oracle.connect(feeder).updatePrice("HBL", pkr(145));
      await time.increase(11 * 60);

      expect(await oracle.isStale("HBL")).to.be.true;
    });

    it("admin can update staleness threshold", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      await oracle.connect(admin).setStalenessThreshold(30 * 60); // 30 minutes
      expect(await oracle.stalenessThreshold()).to.equal(1800n);
    });
  });

  // ─── Ticker Deactivation ──────────────────────────────────────────────────

  describe("setTickerActive()", function () {
    it("admin can pause a ticker feed", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      await oracle.connect(admin).setTickerActive("OGDC", false);

      const feed = await oracle.feeds("OGDC");
      expect(feed.isActive).to.be.false;
    });

    it("feeder cannot update price of paused ticker", async function () {
      const { oracle, admin, feeder } = await loadFixture(fixture);
      await oracle.connect(admin).setTickerActive("OGDC", false);

      await expect(
        oracle.connect(feeder).updatePrice("OGDC", pkr(180))
      ).to.be.revertedWith("Oracle: ticker feed is paused");
    });

    it("admin can reactivate a ticker", async function () {
      const { oracle, admin, feeder } = await loadFixture(fixture);
      await oracle.connect(admin).setTickerActive("OGDC", false);
      await oracle.connect(admin).setTickerActive("OGDC", true);

      await expect(
        oracle.connect(feeder).updatePrice("OGDC", pkr(182))
      ).to.not.be.reverted;
    });
  });

  // ─── Admin Transfer ───────────────────────────────────────────────────────

  describe("transferAdmin()", function () {
    it("transfers oracle admin", async function () {
      const { oracle, admin, alice } = await loadFixture(fixture);
      await oracle.connect(admin).transferAdmin(alice.address);
      expect(await oracle.admin()).to.equal(alice.address);
    });

    it("reverts on zero address", async function () {
      const { oracle, admin } = await loadFixture(fixture);
      await expect(
        oracle.connect(admin).transferAdmin(ethers.ZeroAddress)
      ).to.be.revertedWith("Oracle: invalid address");
    });
  });
});
