// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PSXToken.sol";

/**
 * @title PSXTokenFactory
 * @notice Admin-controlled factory that deploys a new PSXToken contract
 *         for each PSX-listed company. Keeps a registry of all deployed tokens.
 */
contract PSXTokenFactory {

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    address public admin;

    struct CompanyInfo {
        string  companyName;
        string  ticker;
        string  sector;
        address tokenAddress;
        uint256 listedAt;      // block timestamp of listing
        bool    isActive;
    }

    /// @notice ticker => CompanyInfo
    mapping(string => CompanyInfo) public companies;

    /// @notice All listed tickers in order
    string[] public allTickers;

    /// @notice token address => ticker (reverse lookup)
    mapping(address => string) public tokenToTicker;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event CompanyListed(
        string  indexed ticker,
        string  companyName,
        string  sector,
        address tokenAddress,
        uint256 initialSupply
    );

    event CompanyDelisted(string indexed ticker);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == admin, "Factory: caller is not admin");
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    constructor() {
        admin = msg.sender;
    }

    // ─────────────────────────────────────────────
    //  Core — List a New Company
    // ─────────────────────────────────────────────

    /**
     * @notice Deploy a new ERC-20 token for a PSX-listed company.
     * @param _companyName   Full legal name  e.g. "Habib Bank Limited"
     * @param _ticker        Unique PSX ticker e.g. "HBL"
     * @param _sector        PSX sector        e.g. "Banking"
     * @param _initialSupply Whole shares to mint to admin on deployment
     * @return tokenAddress  Address of the newly deployed PSXToken
     */
    function listCompany(
        string memory _companyName,
        string memory _ticker,
        string memory _sector,
        uint256 _initialSupply
    ) external onlyAdmin returns (address tokenAddress) {
        require(bytes(_ticker).length > 0,       "Factory: ticker cannot be empty");
        require(bytes(_companyName).length > 0,  "Factory: name cannot be empty");
        require(
            companies[_ticker].tokenAddress == address(0),
            "Factory: ticker already listed"
        );

        // Deploy a new PSXToken; admin of the token is this factory's admin
        PSXToken token = new PSXToken(
            _companyName,
            _ticker,
            _sector,
            _initialSupply,
            admin
        );

        tokenAddress = address(token);

        companies[_ticker] = CompanyInfo({
            companyName:  _companyName,
            ticker:       _ticker,
            sector:       _sector,
            tokenAddress: tokenAddress,
            listedAt:     block.timestamp,
            isActive:     true
        });

        allTickers.push(_ticker);
        tokenToTicker[tokenAddress] = _ticker;

        emit CompanyListed(_ticker, _companyName, _sector, tokenAddress, _initialSupply);
    }

    // ─────────────────────────────────────────────
    //  Core — Delist a Company
    // ─────────────────────────────────────────────

    /**
     * @notice Mark a company as delisted (does NOT destroy the token contract).
     *         Existing holders keep their tokens; new trading is stopped at exchange level.
     */
    function delistCompany(string memory _ticker) external onlyAdmin {
        require(companies[_ticker].tokenAddress != address(0), "Factory: ticker not found");
        require(companies[_ticker].isActive,                   "Factory: already delisted");

        companies[_ticker].isActive = false;
        emit CompanyDelisted(_ticker);
    }

    // ─────────────────────────────────────────────
    //  View Helpers
    // ─────────────────────────────────────────────

    /// @notice Get token address for a ticker
    function getTokenAddress(string memory _ticker) external view returns (address) {
        return companies[_ticker].tokenAddress;
    }

    /// @notice Get full company info for a ticker
    function getCompanyInfo(string memory _ticker)
        external
        view
        returns (CompanyInfo memory)
    {
        return companies[_ticker];
    }

    /// @notice Get total number of listed companies
    function totalCompanies() external view returns (uint256) {
        return allTickers.length;
    }

    /// @notice Get all tickers as an array (for frontend to iterate)
    function getAllTickers() external view returns (string[] memory) {
        return allTickers;
    }

    /// @notice Get all active (not delisted) tickers
    function getActiveTickers() external view returns (string[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < allTickers.length; i++) {
            if (companies[allTickers[i]].isActive) count++;
        }

        string[] memory active = new string[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < allTickers.length; i++) {
            if (companies[allTickers[i]].isActive) {
                active[idx++] = allTickers[i];
            }
        }
        return active;
    }

    // ─────────────────────────────────────────────
    //  Admin Transfer
    // ─────────────────────────────────────────────

    function transferAdmin(address _newAdmin) external onlyAdmin {
        require(_newAdmin != address(0), "Factory: invalid address");
        emit AdminTransferred(admin, _newAdmin);
        admin = _newAdmin;
    }
}
