// test/02_PSXTokenFactory.test.js
const { expect }              = require("chai");
const { ethers }              = require("hardhat");
const { loadFixture }         = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployAll, shares }   = require("./helpers");

describe("PSXTokenFactory", function () {

  async function fixture() {
    return deployAll();
  }

  // ─── Initial State ────────────────────────────────────────────────────────

  describe("Initial state", function () {
    it("sets deployer as admin", async function () {
      const { factory, admin } = await loadFixture(fixture);
      expect(await factory.admin()).to.equal(admin.address);
    });

    it("lists the 3 sample companies from deployAll", async function () {
      const { factory } = await loadFixture(fixture);
      expect(await factory.totalCompanies()).to.equal(3n);
    });

    it("getAllTickers returns correct tickers", async function () {
      const { factory } = await loadFixture(fixture);
      const tickers = await factory.getAllTickers();
      expect(tickers).to.include("OGDC");
      expect(tickers).to.include("HBL");
      expect(tickers).to.include("PSO");
    });
  });

  // ─── listCompany ──────────────────────────────────────────────────────────

  describe("listCompany()", function () {
    it("deploys a new PSXToken and stores it", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await factory.connect(admin).listCompany("Lucky Cement", "LUCK", "Cement", 300_000n);

      const addr = await factory.getTokenAddress("LUCK");
      expect(addr).to.not.equal(ethers.ZeroAddress);
    });

    it("mints correct initial supply to admin", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await factory.connect(admin).listCompany("Test Corp", "TEST", "Tech", 50_000n);

      const tokenAddr = await factory.getTokenAddress("TEST");
      const token = await ethers.getContractAt("PSXToken", tokenAddr);
      expect(await token.balanceOf(admin.address)).to.equal(shares(50_000));
    });

    it("stores correct company metadata", async function () {
      const { factory } = await loadFixture(fixture);
      const info = await factory.getCompanyInfo("OGDC");

      expect(info.companyName).to.equal("Oil & Gas Development Company");
      expect(info.sector).to.equal("Energy");
      expect(info.isActive).to.be.true;
      expect(info.tokenAddress).to.not.equal(ethers.ZeroAddress);
    });

    it("reverts if ticker already listed", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await expect(
        factory.connect(admin).listCompany("Duplicate", "OGDC", "Energy", 100n)
      ).to.be.revertedWith("Factory: ticker already listed");
    });

    it("reverts with empty ticker", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await expect(
        factory.connect(admin).listCompany("No Ticker Corp", "", "Tech", 100n)
      ).to.be.revertedWith("Factory: ticker cannot be empty");
    });

    it("reverts with empty company name", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await expect(
        factory.connect(admin).listCompany("", "NEW", "Tech", 100n)
      ).to.be.revertedWith("Factory: name cannot be empty");
    });

    it("non-admin cannot list company", async function () {
      const { factory, alice } = await loadFixture(fixture);
      await expect(
        factory.connect(alice).listCompany("Hacker Corp", "HACK", "Other", 100n)
      ).to.be.revertedWith("Factory: caller is not admin");
    });

    it("emits CompanyListed event with correct args", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await expect(
        factory.connect(admin).listCompany("New Energy Ltd", "NEL", "Energy", 100_000n)
      )
        .to.emit(factory, "CompanyListed")
        .withArgs(
          "NEL",
          "New Energy Ltd",
          "Energy",
          await factory.getTokenAddress("NEL").catch(() => ethers.ZeroAddress),
          100_000n
        );
    });
  });

  // ─── delistCompany ────────────────────────────────────────────────────────

  describe("delistCompany()", function () {
    it("marks company as inactive", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await factory.connect(admin).delistCompany("HBL");

      const info = await factory.getCompanyInfo("HBL");
      expect(info.isActive).to.be.false;
    });

    it("does not destroy the token contract", async function () {
      const { factory, admin, tokens } = await loadFixture(fixture);
      await factory.connect(admin).delistCompany("HBL");

      // Token contract still accessible
      expect(await tokens["HBL"].name()).to.equal("Habib Bank Limited");
    });

    it("reverts when delisting unknown ticker", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await expect(
        factory.connect(admin).delistCompany("FAKE")
      ).to.be.revertedWith("Factory: ticker not found");
    });

    it("reverts when delisting already-delisted ticker", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await factory.connect(admin).delistCompany("PSO");
      await expect(
        factory.connect(admin).delistCompany("PSO")
      ).to.be.revertedWith("Factory: already delisted");
    });

    it("non-admin cannot delist", async function () {
      const { factory, alice } = await loadFixture(fixture);
      await expect(
        factory.connect(alice).delistCompany("OGDC")
      ).to.be.revertedWith("Factory: caller is not admin");
    });
  });

  // ─── getActiveTickers ─────────────────────────────────────────────────────

  describe("getActiveTickers()", function () {
    it("excludes delisted companies", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await factory.connect(admin).delistCompany("HBL");

      const active = await factory.getActiveTickers();
      expect(active).to.not.include("HBL");
      expect(active).to.include("OGDC");
      expect(active).to.include("PSO");
    });

    it("returns all when none delisted", async function () {
      const { factory } = await loadFixture(fixture);
      const active = await factory.getActiveTickers();
      expect(active.length).to.equal(3);
    });
  });

  // ─── Admin Transfer ───────────────────────────────────────────────────────

  describe("transferAdmin()", function () {
    it("transfers admin role", async function () {
      const { factory, admin, alice } = await loadFixture(fixture);
      await factory.connect(admin).transferAdmin(alice.address);
      expect(await factory.admin()).to.equal(alice.address);
    });

    it("old admin loses privileges", async function () {
      const { factory, admin, alice } = await loadFixture(fixture);
      await factory.connect(admin).transferAdmin(alice.address);
      await expect(
        factory.connect(admin).listCompany("X", "X", "X", 1n)
      ).to.be.revertedWith("Factory: caller is not admin");
    });

    it("reverts on zero address", async function () {
      const { factory, admin } = await loadFixture(fixture);
      await expect(
        factory.connect(admin).transferAdmin(ethers.ZeroAddress)
      ).to.be.revertedWith("Factory: invalid address");
    });
  });
});
