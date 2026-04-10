// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PSXOracle
 * @notice On-chain price feed for PSX-listed share tokens.
 *         An off-chain Python script fetches real prices from Yahoo Finance
 *         and calls updatePrice() periodically — this is the "oracle" pattern
 *         used by protocols like Chainlink in production DeFi.
 *
 *         Prices are stored in PKR (Pakistani Rupees) scaled by 1e8
 *         e.g. Rs. 180.50 is stored as 18050000000
 *
 *         The PSXExchange can read from this contract to display
 *         real-world reference prices alongside AMM prices.
 */
contract PSXOracle {

    // ─────────────────────────────────────────────
    //  Structs
    // ─────────────────────────────────────────────

    struct PriceFeed {
        uint256 price;          // PKR price scaled by 1e8
        uint256 updatedAt;      // block.timestamp of last update
        uint256 roundId;        // increments on every update
        bool    isActive;       // false = feed paused / ticker delisted
    }

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    address public admin;

    /// @notice Addresses allowed to push price updates (the Python feeder wallets)
    mapping(address => bool) public isFeeder;

    /// @notice ticker => latest price feed
    mapping(string => PriceFeed) public feeds;

    /// @notice ticker => historical prices (roundId => price)
    mapping(string => mapping(uint256 => uint256)) public priceHistory;

    /// @notice All registered tickers
    string[] public tickers;
    mapping(string => bool) public tickerExists;

    /// @notice Maximum age of a price before it's considered stale (default 10 minutes)
    uint256 public stalenessThreshold = 10 minutes;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event PriceUpdated(
        string  indexed ticker,
        uint256 price,
        uint256 timestamp,
        uint256 roundId,
        address feeder
    );

    event TickerRegistered(string indexed ticker);
    event FeederUpdated(address indexed feeder, bool status);
    event StalenessThresholdUpdated(uint256 newThreshold);

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == admin, "Oracle: caller is not admin");
        _;
    }

    modifier onlyFeeder() {
        require(isFeeder[msg.sender], "Oracle: caller is not an authorized feeder");
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    constructor() {
        admin = msg.sender;
        // Admin is also a feeder by default
        isFeeder[msg.sender] = true;
        emit FeederUpdated(msg.sender, true);
    }

    // ─────────────────────────────────────────────
    //  Admin — Setup
    // ─────────────────────────────────────────────

    /// @notice Register a new ticker so the oracle can track it
    function registerTicker(string memory _ticker) external onlyAdmin {
        require(!tickerExists[_ticker], "Oracle: ticker already registered");
        tickers.push(_ticker);
        tickerExists[_ticker] = true;
        feeds[_ticker].isActive = true;
        emit TickerRegistered(_ticker);
    }

    /// @notice Batch register multiple tickers at once
    function registerTickers(string[] memory _tickers) external onlyAdmin {
        for (uint256 i = 0; i < _tickers.length; i++) {
            if (!tickerExists[_tickers[i]]) {
                tickers.push(_tickers[i]);
                tickerExists[_tickers[i]] = true;
                feeds[_tickers[i]].isActive = true;
                emit TickerRegistered(_tickers[i]);
            }
        }
    }

    /// @notice Authorize or revoke a feeder wallet
    function setFeeder(address _feeder, bool _status) external onlyAdmin {
        require(_feeder != address(0), "Oracle: invalid address");
        isFeeder[_feeder] = _status;
        emit FeederUpdated(_feeder, _status);
    }

    /// @notice Update how old a price can be before it's stale
    function setStalenessThreshold(uint256 _seconds) external onlyAdmin {
        stalenessThreshold = _seconds;
        emit StalenessThresholdUpdated(_seconds);
    }

    /// @notice Pause or resume a ticker's feed
    function setTickerActive(string memory _ticker, bool _status) external onlyAdmin {
        require(tickerExists[_ticker], "Oracle: ticker not registered");
        feeds[_ticker].isActive = _status;
    }

    // ─────────────────────────────────────────────
    //  Feeder — Push Price Updates
    // ─────────────────────────────────────────────

    /**
     * @notice Push a new price for a single ticker.
     * @param _ticker  PSX ticker e.g. "OGDC"
     * @param _price   Price in PKR scaled by 1e8 (e.g. Rs.180.50 → 18050000000)
     */
    function updatePrice(string memory _ticker, uint256 _price) external onlyFeeder {
        require(tickerExists[_ticker],      "Oracle: ticker not registered");
        require(feeds[_ticker].isActive,    "Oracle: ticker feed is paused");
        require(_price > 0,                 "Oracle: price must be > 0");

        uint256 newRoundId = feeds[_ticker].roundId + 1;

        priceHistory[_ticker][newRoundId] = _price;

        feeds[_ticker] = PriceFeed({
            price:     _price,
            updatedAt: block.timestamp,
            roundId:   newRoundId,
            isActive:  true
        });

        emit PriceUpdated(_ticker, _price, block.timestamp, newRoundId, msg.sender);
    }

    /**
     * @notice Push prices for multiple tickers in one transaction (gas efficient).
     * @param _tickers Array of tickers
     * @param _prices  Corresponding prices (same index), scaled by 1e8
     */
    function batchUpdatePrices(
        string[] memory _tickers,
        uint256[] memory _prices
    ) external onlyFeeder {
        require(_tickers.length == _prices.length, "Oracle: array length mismatch");

        for (uint256 i = 0; i < _tickers.length; i++) {
            string memory ticker = _tickers[i];
            uint256 price        = _prices[i];

            if (!tickerExists[ticker] || !feeds[ticker].isActive || price == 0) continue;

            uint256 newRoundId = feeds[ticker].roundId + 1;
            priceHistory[ticker][newRoundId] = price;

            feeds[ticker] = PriceFeed({
                price:     price,
                updatedAt: block.timestamp,
                roundId:   newRoundId,
                isActive:  true
            });

            emit PriceUpdated(ticker, price, block.timestamp, newRoundId, msg.sender);
        }
    }

    // ─────────────────────────────────────────────
    //  View — Read Prices
    // ─────────────────────────────────────────────

    /**
     * @notice Get the latest price for a ticker.
     * @return price      PKR price scaled by 1e8
     * @return updatedAt  Timestamp of last update
     * @return roundId    Current round number
     */
    function getLatestPrice(string memory _ticker)
        external
        view
        returns (uint256 price, uint256 updatedAt, uint256 roundId)
    {
        require(tickerExists[_ticker], "Oracle: ticker not registered");
        PriceFeed memory feed = feeds[_ticker];
        return (feed.price, feed.updatedAt, feed.roundId);
    }

    /**
     * @notice Get price and whether it is fresh (not stale).
     * @return price    PKR price scaled by 1e8
     * @return isFresh  True if updated within stalenessThreshold
     */
    function getPrice(string memory _ticker)
        external
        view
        returns (uint256 price, bool isFresh)
    {
        require(tickerExists[_ticker], "Oracle: ticker not registered");
        PriceFeed memory feed = feeds[_ticker];
        price   = feed.price;
        isFresh = (block.timestamp - feed.updatedAt) <= stalenessThreshold;
    }

    /// @notice Get a historical price by round ID
    function getHistoricalPrice(string memory _ticker, uint256 _roundId)
        external
        view
        returns (uint256)
    {
        return priceHistory[_ticker][_roundId];
    }

    /// @notice Get all registered tickers
    function getAllTickers() external view returns (string[] memory) {
        return tickers;
    }

    /// @notice Check if a ticker's price is stale
    function isStale(string memory _ticker) external view returns (bool) {
        return (block.timestamp - feeds[_ticker].updatedAt) > stalenessThreshold;
    }

    // ─────────────────────────────────────────────
    //  Admin Transfer
    // ─────────────────────────────────────────────

    function transferAdmin(address _newAdmin) external onlyAdmin {
        require(_newAdmin != address(0), "Oracle: invalid address");
        admin = _newAdmin;
    }
}
