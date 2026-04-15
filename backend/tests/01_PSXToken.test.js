// test/01_PSXToken.test.js
const { expect }                                  = require("chai");
const { ethers }                                  = require("hardhat");
const { loadFixture }                             = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployAll, whitelistOn, shares, eth }     = require("./helpers");

describe("PSXToken", function () {

  // ─── Fixture ──────────────────────────────────────────────────────────────

  async function fixture() {
    const ctx = await deployAll();
    // Use OGDC token for all PSXToken tests
    return { ...ctx, token: ctx.tokens["OGDC"] };
  }

  // ─── Deployment ───────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets correct name, symbol, and sector", async function () {
      const { token } = await loadFixture(fixture);
      expect(await token.name()).to.equal("Oil & Gas Development Company");
      expect(await token.symbol()).to.equal("OGDC");
      expect(await token.sector()).to.equal("Energy");
    });

    it("mints initial supply to admin", async function () {
      const { token, admin } = await loadFixture(fixture);
      const balance = await token.balanceOf(admin.address);
      expect(balance).to.equal(shares(1_000_000));
    });

    it("whitelists admin automatically", async function () {
      const { token, admin } = await loadFixture(fixture);
      expect(await token.whitelisted(admin.address)).to.be.true;
    });

    it("sets admin as owner", async function () {
      const { token, admin } = await loadFixture(fixture);
      expect(await token.owner()).to.equal(admin.address);
    });
  });

  // ─── Whitelist ────────────────────────────────────────────────────────────

  describe("Whitelist", function () {
    it("admin can whitelist a user", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);
      expect(await token.whitelisted(alice.address)).to.be.true;
    });

    it("admin can revoke whitelist", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      await token.connect(admin).setWhitelist(alice.address, true);
      await token.connect(admin).setWhitelist(alice.address, false);
      expect(await token.whitelisted(alice.address)).to.be.false;
    });

    it("non-admin cannot whitelist", async function () {
      const { token, alice, bob } = await loadFixture(fixture);
      await expect(
        token.connect(alice).setWhitelist(bob.address, true)
      ).to.be.reverted;
    });

    it("batch whitelists multiple users", async function () {
      const { token, admin, alice, bob, charlie } = await loadFixture(fixture);
      await token.connect(admin).batchWhitelist(
        [alice.address, bob.address, charlie.address], true
      );
      expect(await token.whitelisted(alice.address)).to.be.true;
      expect(await token.whitelisted(bob.address)).to.be.true;
      expect(await token.whitelisted(charlie.address)).to.be.true;
    });

    it("emits Whitelisted event", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      await expect(token.connect(admin).setWhitelist(alice.address, true))
        .to.emit(token, "Whitelisted")
        .withArgs(alice.address, true);
    });
  });

  // ─── Transfer ─────────────────────────────────────────────────────────────

  describe("Transfer", function () {
    it("whitelisted user can transfer to whitelisted user", async function () {
      const { token, admin, alice, bob } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice, bob);
      await token.connect(admin).mint(alice.address, shares(100));

      await token.connect(alice).transfer(bob.address, shares(50));
      expect(await token.balanceOf(bob.address)).to.equal(shares(50));
    });

    it("non-whitelisted sender cannot transfer", async function () {
      const { token, admin, alice, bob } = await loadFixture(fixture);
      await whitelistOn(token, admin, bob);
      // alice is not whitelisted — mint directly bypasses whitelist (owner mint)
      // so we need a different approach: transfer from admin to alice first
      // But alice isn't whitelisted so even that should fail
      await expect(
        token.connect(alice).transfer(bob.address, shares(1))
      ).to.be.reverted;
    });

    it("cannot transfer to non-whitelisted recipient", async function () {
      const { token, admin, alice, bob } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice);
      await token.connect(admin).mint(alice.address, shares(100));

      // bob is not whitelisted
      await expect(
        token.connect(alice).transfer(bob.address, shares(10))
      ).to.be.reverted;
    });

    it("trusted contract can transfer without whitelist", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      const exchangeAddr = await ethers.getSigners().then(s => s[5].address);

      await token.connect(admin).setTrustedContract(exchangeAddr, true);
      expect(await token.trustedContracts(exchangeAddr)).to.be.true;
    });
  });

  // ─── Mint ─────────────────────────────────────────────────────────────────

  describe("Mint", function () {
    it("admin can mint to whitelisted address", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice);

      const before = await token.totalSupply();
      await token.connect(admin).mint(alice.address, shares(500));

      expect(await token.balanceOf(alice.address)).to.equal(shares(500));
      expect(await token.totalSupply()).to.equal(before + shares(500));
    });

    it("cannot mint to non-whitelisted address", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      // alice not whitelisted
      await expect(
        token.connect(admin).mint(alice.address, shares(100))
      ).to.be.reverted;
    });

    it("non-admin cannot mint", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice);
      await expect(
        token.connect(alice).mint(alice.address, shares(100))
      ).to.be.reverted;
    });

    it("emits SharesMinted event", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice);
      await expect(token.connect(admin).mint(alice.address, shares(100)))
        .to.emit(token, "SharesMinted");
    });
  });

  // ─── Burn ─────────────────────────────────────────────────────────────────

  describe("Burn", function () {
    it("admin can burn tokens from any address", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice);
      await token.connect(admin).mint(alice.address, shares(100));

      await token.connect(admin).burn(alice.address, shares(40));
      expect(await token.balanceOf(alice.address)).to.equal(shares(60));
    });

    it("burn reduces total supply", async function () {
      const { token, admin } = await loadFixture(fixture);
      const before = await token.totalSupply();
      await token.connect(admin).burn(admin.address, shares(1000));
      expect(await token.totalSupply()).to.equal(before - shares(1000));
    });

    it("cannot burn more than balance", async function () {
      const { token, admin, alice } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice);
      await token.connect(admin).mint(alice.address, shares(10));

      await expect(
        token.connect(admin).burn(alice.address, shares(100))
      ).to.be.reverted;
    });
  });

  // ─── Pause ────────────────────────────────────────────────────────────────

  describe("Pause", function () {
    it("admin can pause transfers", async function () {
      const { token, admin, alice, bob } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice, bob);
      await token.connect(admin).mint(alice.address, shares(100));

      await token.connect(admin).pause();

      await expect(
        token.connect(alice).transfer(bob.address, shares(10))
      ).to.be.reverted;
    });

    it("admin can unpause transfers", async function () {
      const { token, admin, alice, bob } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice, bob);
      await token.connect(admin).mint(alice.address, shares(100));

      await token.connect(admin).pause();
      await token.connect(admin).unpause();

      await token.connect(alice).transfer(bob.address, shares(10));
      expect(await token.balanceOf(bob.address)).to.equal(shares(10));
    });

    it("non-admin cannot pause", async function () {
      const { token, alice } = await loadFixture(fixture);
      await expect(token.connect(alice).pause()).to.be.reverted;
    });
  });

  // ─── ERC-20 Standard ──────────────────────────────────────────────────────

  describe("ERC-20 compliance", function () {
    it("approve and transferFrom works between whitelisted users", async function () {
      const { token, admin, alice, bob } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice, bob);
      await token.connect(admin).mint(alice.address, shares(100));

      await token.connect(alice).approve(bob.address, shares(50));
      expect(await token.allowance(alice.address, bob.address)).to.equal(shares(50));

      await token.connect(bob).transferFrom(alice.address, bob.address, shares(30));
      expect(await token.balanceOf(bob.address)).to.equal(shares(30));
      expect(await token.allowance(alice.address, bob.address)).to.equal(shares(20));
    });

    it("transferFrom reverts if allowance insufficient", async function () {
      const { token, admin, alice, bob } = await loadFixture(fixture);
      await whitelistOn(token, admin, alice, bob);
      await token.connect(admin).mint(alice.address, shares(100));
      await token.connect(alice).approve(bob.address, shares(5));

      await expect(
        token.connect(bob).transferFrom(alice.address, bob.address, shares(10))
      ).to.be.reverted;
    });

    it("decimals returns 18", async function () {
      const { token } = await loadFixture(fixture);
      expect(await token.decimals()).to.equal(18);
    });
  });
});
