// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./PSXToken.sol";
import "./PSXTokenFactory.sol";
import "./LiquidityPool.sol";

/**
 * @title PSXExchange
 * @notice Main entry point for the PSX tokenization platform.
 *
 *         Responsibilities:
 *         1. Create a LiquidityPool for any token listed on PSXTokenFactory
 *         2. Route addLiquidity / removeLiquidity calls to the correct pool
 *         3. Route buy (ETH → token) and sell (token → ETH) swaps
 *         4. Collect and track 0.1% platform fees on top of AMM fees
 *
 * @dev BUG 2 FIX — removeLiquidity:
 *      Slippage checks now happen BEFORE pool.removeLiquidity() executes,
 *      using a read-only preview. This prevents ETH getting stuck in the
 *      exchange if slippage fails after the pool already moved funds.
 *
 * @dev BUG 3 FIX — sellShares and buyShares:
 *      Quote is fetched first (read-only), platform fee is applied to the
 *      quote, then slippage is checked against the post-fee amount.
 *      Only then is the actual swap executed. Order: quote → check → execute.
 */
contract PSXExchange is ReentrancyGuard {

    // ─────────────────────────────────────────────
    //  Constants
    // ─────────────────────────────────────────────

    uint256 public constant PLATFORM_FEE_BPS = 10;    // 0.1% platform fee
    uint256 public constant BPS_DENOMINATOR  = 10000;

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    address public admin;
    PSXTokenFactory public immutable factory;

    mapping(address => address) public pools;   // token → pool
    address[] public allPools;

    uint256 public platformFeeBalance;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event PoolCreated(address indexed token, address indexed pool, string ticker);

    event LiquidityAdded(
        address indexed provider,
        address indexed token,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 lpTokens
    );

    event LiquidityRemoved(
        address indexed provider,
        address indexed token,
        uint256 ethAmount,
        uint256 tokenAmount
    );

    event SharesBought(
        address indexed buyer,
        address indexed token,
        uint256 ethSpent,
        uint256 tokensReceived
    );

    event SharesSold(
        address indexed seller,
        address indexed token,
        uint256 tokensSold,
        uint256 ethReceived
    );

    event PlatformFeeWithdrawn(address indexed to, uint256 amount);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == admin, "Exchange: caller is not admin");
        _;
    }

    modifier poolExists(address _token) {
        require(pools[_token] != address(0), "Exchange: no pool for this token");
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    constructor(address _factory) {
        require(_factory != address(0), "Exchange: invalid factory address");
        admin   = msg.sender;
        factory = PSXTokenFactory(_factory);
    }

    // ─────────────────────────────────────────────
    //  Pool Management
    // ─────────────────────────────────────────────

    function createPool(string memory _ticker)
        external onlyAdmin returns (address pool)
    {
        address tokenAddr = factory.getTokenAddress(_ticker);
        require(tokenAddr != address(0),        "Exchange: ticker not listed on factory");
        require(pools[tokenAddr] == address(0), "Exchange: pool already exists");

        PSXTokenFactory.CompanyInfo memory info = factory.getCompanyInfo(_ticker);
        require(info.isActive, "Exchange: company is delisted");

        LiquidityPool newPool = new LiquidityPool(tokenAddr, address(this), _ticker);
        pool = address(newPool);

        pools[tokenAddr] = pool;
        allPools.push(pool);

        // // Allow pool to transfer tokens without whitelist check
        // PSXToken(tokenAddr).setTrustedContract(pool, true);

        emit PoolCreated(tokenAddr, pool, _ticker);
    }

    // ─────────────────────────────────────────────
    //  Add Liquidity
    // ─────────────────────────────────────────────

    /**
     * @notice Deposit ETH + share tokens into a pool and receive LP tokens.
     *
     * Steps for the caller:
     *   1. Call token.approve(exchangeAddress, _tokenAmount)
     *   2. Call this function with msg.value = ETH to deposit
     *
     * @param _token       Share token address
     * @param _tokenAmount Share tokens to deposit
     * @param _minLP       Minimum LP tokens to receive (slippage guard)
     */
    function addLiquidity(address _token, uint256 _tokenAmount, uint256 _minLP)
        external payable nonReentrant poolExists(_token)
    {
        require(msg.value > 0,    "Exchange: must send ETH");
        require(_tokenAmount > 0, "Exchange: token amount must be > 0");

        LiquidityPool pool = LiquidityPool(payable(pools[_token]));

        // Pull tokens from user directly into the pool
        require(
            IERC20(_token).transferFrom(msg.sender, address(pool), _tokenAmount),
            "Exchange: token transfer failed - did you approve?"
        );

        // Forward ETH to pool; pool mints LP tokens to provider
        uint256 lpMinted = pool.addLiquidity{value: msg.value}(msg.sender, _tokenAmount);
        require(lpMinted >= _minLP, "Exchange: insufficient LP tokens minted");

        emit LiquidityAdded(msg.sender, _token, msg.value, _tokenAmount, lpMinted);
    }

    // ─────────────────────────────────────────────
    //  Remove Liquidity  ← BUG 2 FIXED
    // ─────────────────────────────────────────────

    /**
     * @notice Burn LP tokens to receive proportional ETH + share tokens back.
     *
     * Steps for the caller:
     *   1. Call pool.approve(exchangeAddress, _lpAmount)  [LP token contract]
     *   2. Call this function
     *
     * @dev BUG 2 FIX — slippage is now checked BEFORE pool.removeLiquidity()
     *      executes, using a read-only reserve preview. Previously slippage was
     *      checked after execution — if it reverted, ETH was already in the
     *      exchange with no path back to the user.
     *
     * @param _token    Share token address
     * @param _lpAmount LP tokens to burn
     * @param _minETH   Minimum ETH to receive
     * @param _minToken Minimum share tokens to receive
     */
    function removeLiquidity(
        address _token,
        uint256 _lpAmount,
        uint256 _minETH,
        uint256 _minToken
    )
        external nonReentrant poolExists(_token)
    {
        require(_lpAmount > 0, "Exchange: LP amount must be > 0");

        LiquidityPool pool = LiquidityPool(payable(pools[_token]));

        // Step 1: Pull LP tokens from user → exchange
        require(
            IERC20(address(pool)).transferFrom(msg.sender, address(this), _lpAmount),
            "Exchange: LP token transfer failed - did you approve?"
        );

        // Step 2: FIXED — preview outputs BEFORE executing, then check slippage
        // This ensures no funds move if slippage check fails
        {
            uint256 supply_  = IERC20(address(pool)).totalSupply();
            (uint256 ethRes, uint256 tokRes) = pool.getReserves();
            uint256 previewETH   = (_lpAmount * ethRes) / supply_;
            uint256 previewToken = (_lpAmount * tokRes) / supply_;
            require(previewETH   >= _minETH,   "Exchange: ETH output below minimum");
            require(previewToken >= _minToken,  "Exchange: token output below minimum");
        }

        // Step 3: Execute — pool burns from exchange, sends ETH + tokens here
        (uint256 ethOut, uint256 tokenOut) = pool.removeLiquidity(msg.sender, _lpAmount);

        // Step 4: Forward ETH to user
        (bool ok, ) = msg.sender.call{value: ethOut}("");
        require(ok, "Exchange: ETH refund failed");

        // Step 5: Forward tokens to user
        require(
            IERC20(_token).transfer(msg.sender, tokenOut),
            "Exchange: token refund failed"
        );

        emit LiquidityRemoved(msg.sender, _token, ethOut, tokenOut);
    }

    // ─────────────────────────────────────────────
    //  Buy Shares (ETH → Token)  ← BUG 3 FIXED
    // ─────────────────────────────────────────────

    /**
     * @notice Buy share tokens with ETH.
     *         0.1% platform fee is deducted from msg.value before swap.
     *
     * @dev BUG 3 FIX — quote is fetched first (post-fee), slippage is checked
     *      against that quote, THEN the swap executes with _minTokenOut = 0
     *      (since we already verified slippage). Previously _minTokenOut was
     *      passed directly to the pool which checked it against pre-fee amount.
     *
     * @param _token       Share token to buy
     * @param _minTokenOut Minimum tokens to receive AFTER platform fee
     */
    function buyShares(address _token, uint256 _minTokenOut)
        external payable nonReentrant poolExists(_token)
    {
        require(msg.value > 0, "Exchange: must send ETH to buy");

        // Step 1: Calculate fee split
        uint256 fee        = (msg.value * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 ethForSwap = msg.value - fee;

        // Step 2: FIXED — quote output BEFORE executing swap
        LiquidityPool pool = LiquidityPool(payable(pools[_token]));
        uint256 tokenQuote = pool.quoteETHForToken(ethForSwap);

        // Step 3: FIXED — check slippage against post-fee quote
        require(tokenQuote >= _minTokenOut, "Exchange: token output below minimum");

        // Step 4: Accumulate fee
        platformFeeBalance += fee;

        // Step 5: Execute swap — pass 0 as min since we already checked above
        uint256 tokenOut = pool.swapETHForToken{value: ethForSwap}(msg.sender, 0);

        // Step 6: Deliver tokens to buyer
        require(
            IERC20(_token).transfer(msg.sender, tokenOut),
            "Exchange: token delivery failed"
        );

        emit SharesBought(msg.sender, _token, msg.value, tokenOut);
    }

    // ─────────────────────────────────────────────
    //  Sell Shares (Token → ETH)  ← BUG 3 FIXED
    // ─────────────────────────────────────────────

    /**
     * @notice Sell share tokens to receive ETH.
     *         0.1% platform fee is deducted from ETH output.
     *
     * Steps for caller:
     *   1. Call token.approve(exchangeAddress, _tokenAmount)
     *   2. Call this function
     *
     * @dev BUG 3 FIX — quote is fetched first, fee applied to quote, slippage
     *      checked against post-fee quote, THEN swap executes. Previously tokens
     *      moved to pool before slippage check, leaving seller with nothing if
     *      the second require() reverted.
     *
     * @param _token       Share token to sell
     * @param _tokenAmount Amount of tokens to sell
     * @param _minETHOut   Minimum ETH to receive AFTER platform fee
     */
    function sellShares(address _token, uint256 _tokenAmount, uint256 _minETHOut)
        external nonReentrant poolExists(_token)
    {
        require(_tokenAmount > 0, "Exchange: token amount must be > 0");

        LiquidityPool pool = LiquidityPool(payable(pools[_token]));

        // Step 1: FIXED — quote output BEFORE any state changes
        uint256 rawQuote     = pool.quoteTokenForETH(_tokenAmount);
        uint256 feeQuote     = (rawQuote * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netQuote     = rawQuote - feeQuote;

        // Step 2: FIXED — check slippage against post-fee quote
        require(netQuote >= _minETHOut, "Exchange: ETH output below minimum after fees");

        // Step 3: Pull tokens from seller → pool
        require(
            IERC20(_token).transferFrom(msg.sender, address(pool), _tokenAmount),
            "Exchange: token transfer failed - did you approve?"
        );

        // Step 4: Execute swap — pass 0 as min since we already checked above
        uint256 ethOut = pool.swapTokenForETH(msg.sender, _tokenAmount, 0);

        // Step 5: Deduct platform fee from actual output
        uint256 fee       = (ethOut * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 ethToUser = ethOut - fee;
        platformFeeBalance += fee;

        // Step 6: Send ETH to seller
        (bool ok, ) = msg.sender.call{value: ethToUser}("");
        require(ok, "Exchange: ETH transfer to seller failed");

        emit SharesSold(msg.sender, _token, _tokenAmount, ethToUser);
    }

    // ─────────────────────────────────────────────
    //  Price Quotes (view)
    // ─────────────────────────────────────────────

    /// @notice Tokens received for _ethIn (after AMM fee + platform fee)
    function quoteBuy(address _token, uint256 _ethIn)
        external view poolExists(_token) returns (uint256)
    {
        uint256 fee        = (_ethIn * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 ethForSwap = _ethIn - fee;
        return LiquidityPool(payable(pools[_token])).quoteETHForToken(ethForSwap);
    }

    /// @notice ETH received for _tokenIn (after AMM fee + platform fee)
    function quoteSell(address _token, uint256 _tokenIn)
        external view poolExists(_token) returns (uint256)
    {
        uint256 rawEth = LiquidityPool(payable(pools[_token])).quoteTokenForETH(_tokenIn);
        uint256 fee    = (rawEth * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        return rawEth - fee;
    }

    /// @notice Current AMM price of share token in ETH (scaled 1e18)
    function getTokenPrice(address _token)
        external view poolExists(_token) returns (uint256)
    {
        return LiquidityPool(payable(pools[_token])).tokenPriceInETH();
    }

    /// @notice Pool reserves for a token
    function getReserves(address _token)
        external view poolExists(_token)
        returns (uint256 ethReserve, uint256 tokenReserve)
    {
        return LiquidityPool(payable(pools[_token])).getReserves();
    }

    // ─────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────

    function withdrawPlatformFees(address payable _to) external onlyAdmin {
        require(_to != address(0),      "Exchange: invalid address");
        require(platformFeeBalance > 0, "Exchange: no fees to withdraw");

        uint256 amount     = platformFeeBalance;
        platformFeeBalance = 0;

        (bool ok, ) = _to.call{value: amount}("");
        require(ok, "Exchange: fee withdrawal failed");

        emit PlatformFeeWithdrawn(_to, amount);
    }

    function transferAdmin(address _newAdmin) external onlyAdmin {
        require(_newAdmin != address(0), "Exchange: invalid address");
        emit AdminTransferred(admin, _newAdmin);
        admin = _newAdmin;
    }

    // ─────────────────────────────────────────────
    //  View Helpers
    // ─────────────────────────────────────────────

    function getPool(address _token) external view returns (address) {
        return pools[_token];
    }

    function totalPools() external view returns (uint256) {
        return allPools.length;
    }

    receive() external payable {}
}