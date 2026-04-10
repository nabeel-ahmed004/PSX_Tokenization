// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title PSXToken
 * @notice Represents tokenized shares of a PSX-listed company.
 *         Each token = one share (with 18 decimals for fractional ownership).
 *         Only KYC-whitelisted addresses can send or receive tokens.
 */
contract PSXToken is ERC20, Ownable, Pausable {

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    /// @notice Company metadata stored on-chain
    string public companyName;
    string public tickerSymbol;
    string public sector;

    /// @notice KYC whitelist — only approved investors may hold / trade
    mapping(address => bool) public whitelisted;

    /// @notice Addresses that are allowed to transfer freely (e.g. exchange contract)
    mapping(address => bool) public trustedContracts;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event Whitelisted(address indexed user, bool status);
    event TrustedContract(address indexed contractAddr, bool status);
    event SharesMinted(address indexed to, uint256 amount);
    event SharesBurned(address indexed from, uint256 amount);

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    /**
     * @param _companyName  Full company name  e.g. "Oil & Gas Development Company"
     * @param _ticker       Token symbol        e.g. "OGDC"
     * @param _sector       PSX sector          e.g. "Energy"
     * @param _initialSupply Tokens minted to deployer (in whole shares, decimals added internally)
     * @param _admin        Address that will own/admin this token contract
     */
    constructor(
        string memory _companyName,
        string memory _ticker,
        string memory _sector,
        uint256 _initialSupply,
        address _admin
    )
        ERC20(_companyName, _ticker)
        Ownable(_admin)
    {
        companyName  = _companyName;
        tickerSymbol = _ticker;
        sector       = _sector;

        // Whitelist the admin automatically
        whitelisted[_admin] = true;
        emit Whitelisted(_admin, true);

        // Mint initial supply to admin (scaled to 18 decimals)
        if (_initialSupply > 0) {
            _mint(_admin, _initialSupply * (10 ** decimals()));
            emit SharesMinted(_admin, _initialSupply);
        }
    }

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier onlyWhitelisted(address _user) {
        require(
            whitelisted[_user] || trustedContracts[_user],
            "PSXToken: address not KYC approved"
        );
        _;
    }

    // ─────────────────────────────────────────────
    //  Admin — KYC & Trust Management
    // ─────────────────────────────────────────────

    /// @notice Approve or revoke a user's KYC whitelist status
    function setWhitelist(address _user, bool _status) external onlyOwner {
        whitelisted[_user] = _status;
        emit Whitelisted(_user, _status);
    }

    /// @notice Batch whitelist multiple users at once
    function batchWhitelist(address[] calldata _users, bool _status) external onlyOwner {
        for (uint256 i = 0; i < _users.length; i++) {
            whitelisted[_users[i]] = _status;
            emit Whitelisted(_users[i], _status);
        }
    }

    /// @notice Allow an exchange / pool contract to transfer tokens without whitelist check
    function setTrustedContract(address _contract, bool _status) external onlyOwner {
        trustedContracts[_contract] = _status;
        emit TrustedContract(_contract, _status);
    }

    // ─────────────────────────────────────────────
    //  Admin — Supply Management
    // ─────────────────────────────────────────────

    /// @notice Mint new shares to a whitelisted address
    function mint(address _to, uint256 _amount) external onlyOwner onlyWhitelisted(_to) {
        _mint(_to, _amount);
        emit SharesMinted(_to, _amount);
    }

    /// @notice Burn shares from a whitelisted address (e.g. buyback / delisting)
    function burn(address _from, uint256 _amount) external onlyOwner {
        _burn(_from, _amount);
        emit SharesBurned(_from, _amount);
    }

    // ─────────────────────────────────────────────
    //  Admin — Emergency Controls
    // ─────────────────────────────────────────────

    /// @notice Pause all token transfers
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume token transfers
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────────────────────
    //  Internal Overrides
    // ─────────────────────────────────────────────

    /**
     * @dev Hook called before every transfer, mint, and burn.
     *      Enforces pause + whitelist checks.
     *      Trusted contracts (e.g. LiquidityPool) bypass the whitelist.
     */
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override whenNotPaused {
        // Minting (from == 0) and burning (to == 0) skip whitelist
        if (from != address(0) && to != address(0)) {
            require(
                whitelisted[from] || trustedContracts[from],
                "PSXToken: sender not KYC approved"
            );
            require(
                whitelisted[to] || trustedContracts[to],
                "PSXToken: recipient not KYC approved"
            );
        }
        super._update(from, to, amount);
    }
}
