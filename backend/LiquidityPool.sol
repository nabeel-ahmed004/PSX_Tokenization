// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LiquidityPool
 * @notice AMM liquidity pool for one PSX share token paired with ETH.
 *         Uses the constant-product formula: x * y = k
 *         where x = ETH reserve, y = token reserve.
 *
 *         Liquidity providers receive LP tokens proportional to their share.
 *         Swappers pay a 0.3% fee that stays in the pool, accruing to LPs.
 *
 * @dev BUG 1 FIX — removeLiquidity:
 *      Previously called balanceOf(_provider) and _burn(_provider, ...).
 *      PSXExchange pulls LP tokens from the user TO ITSELF before calling
 *      removeLiquidity, so _provider balance is 0 by then.
 *      Fix: check balanceOf(exchange) and _burn(exchange, ...) instead.
 */
contract LiquidityPool is ERC20, ReentrancyGuard {

    // ─────────────────────────────────────────────
    //  Constants
    // ─────────────────────────────────────────────

    uint256 public constant FEE_NUMERATOR    = 997;   // 0.3% fee
    uint256 public constant FEE_DENOMINATOR  = 1000;
    uint256 public constant MINIMUM_LIQUIDITY = 1000; // locked forever

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    IERC20  public immutable psxToken;
    address public immutable exchange;

    uint256 public reserveETH;
    uint256 public reserveToken;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event LiquidityAdded(
        address indexed provider,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 lpTokensMinted
    );

    event LiquidityRemoved(
        address indexed provider,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 lpTokensBurned
    );

    event SwapETHForToken(address indexed trader, uint256 ethIn,    uint256 tokenOut);
    event SwapTokenForETH(address indexed trader, uint256 tokenIn,  uint256 ethOut);

    // ─────────────────────────────────────────────
    //  Modifier
    // ─────────────────────────────────────────────

    modifier onlyExchange() {
        require(msg.sender == exchange, "Pool: caller is not the exchange");
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    constructor(
        address _psxToken,
        address _exchange,
        string memory _ticker
    )
        ERC20(
            string(abi.encodePacked(_ticker, "-ETH LP Token")),
            string(abi.encodePacked(_ticker, "-LP"))
        )
    {
        psxToken = IERC20(_psxToken);
        exchange = _exchange;
    }

    // ─────────────────────────────────────────────
    //  Add Liquidity
    // ─────────────────────────────────────────────

    /**
     * @notice Add ETH + tokens to pool. Only callable by PSXExchange.
     * @param _provider    User receiving LP tokens
     * @param _tokenAmount Tokens already transferred into this contract
     * @return lpMinted    LP tokens minted to _provider
     */
    function addLiquidity(address _provider, uint256 _tokenAmount)
        external payable onlyExchange nonReentrant
        returns (uint256 lpMinted)
    {
        require(msg.value > 0,    "Pool: ETH amount must be > 0");
        require(_tokenAmount > 0, "Pool: token amount must be > 0");

        uint256 ethAmount    = msg.value;
        uint256 totalSupply_ = totalSupply();

        if (totalSupply_ == 0) {
            // First deposit: geometric mean minus minimum liquidity
            lpMinted = _sqrt(ethAmount * _tokenAmount) - MINIMUM_LIQUIDITY;
            _mint(address(1), MINIMUM_LIQUIDITY); // lock forever
        } else {
            // Subsequent: proportional to the smaller contribution
            uint256 lpFromETH   = (ethAmount    * totalSupply_) / reserveETH;
            uint256 lpFromToken = (_tokenAmount * totalSupply_) / reserveToken;
            lpMinted = lpFromETH < lpFromToken ? lpFromETH : lpFromToken;
        }

        require(lpMinted > 0, "Pool: insufficient liquidity minted");

        reserveETH   += ethAmount;
        reserveToken += _tokenAmount;

        _mint(_provider, lpMinted);
        emit LiquidityAdded(_provider, ethAmount, _tokenAmount, lpMinted);
    }

    // ─────────────────────────────────────────────
    //  Remove Liquidity  ← BUG 1 FIXED
    // ─────────────────────────────────────────────

    /**
     * @notice Burn LP tokens held by the exchange and return ETH + tokens.
     *
     * @dev Why we burn from `exchange` not `_provider`:
     *      PSXExchange.removeLiquidity() transfers LP tokens from the user
     *      to address(this)/exchange BEFORE calling this function.
     *      So at this point: provider LP balance = 0, exchange LP balance = _lpAmount.
     *      _provider is kept only for the event log.
     *
     * @param _provider  Original LP provider (event log only)
     * @param _lpAmount  LP tokens to burn (must be held by exchange)
     * @return ethOut    ETH sent to exchange
     * @return tokenOut  Tokens sent to exchange
     */
    function removeLiquidity(address _provider, uint256 _lpAmount)
        external onlyExchange nonReentrant
        returns (uint256 ethOut, uint256 tokenOut)
    {
        require(_lpAmount > 0, "Pool: LP amount must be > 0");

        // FIXED: check exchange's balance, not provider's
        require(
            balanceOf(exchange) >= _lpAmount,
            "Pool: insufficient LP balance in exchange"
        );

        uint256 totalSupply_ = totalSupply();

        ethOut   = (_lpAmount * reserveETH)   / totalSupply_;
        tokenOut = (_lpAmount * reserveToken) / totalSupply_;

        require(ethOut > 0 && tokenOut > 0, "Pool: insufficient liquidity burned");

        reserveETH   -= ethOut;
        reserveToken -= tokenOut;

        // FIXED: burn from exchange (that's where the LP tokens are)
        _burn(exchange, _lpAmount);

        // Return ETH to exchange (exchange forwards to user)
        (bool ok, ) = exchange.call{value: ethOut}("");
        require(ok, "Pool: ETH transfer to exchange failed");

        // Return tokens to exchange (exchange forwards to user)
        require(
            psxToken.transfer(exchange, tokenOut),
            "Pool: token transfer to exchange failed"
        );

        emit LiquidityRemoved(_provider, ethOut, tokenOut, _lpAmount);
    }

    // ─────────────────────────────────────────────
    //  Swap ETH → Token
    // ─────────────────────────────────────────────

    /**
     * @notice Swap ETH for share tokens. ETH arrives as msg.value.
     * @param _trader      Buyer address (event log + slippage context)
     * @param _minTokenOut Minimum tokens out — pass 0 if exchange pre-checked
     * @return tokenOut    Tokens transferred to exchange
     */
    function swapETHForToken(address _trader, uint256 _minTokenOut)
        external payable onlyExchange nonReentrant
        returns (uint256 tokenOut)
    {
        require(msg.value > 0, "Pool: ETH amount must be > 0");
        require(reserveETH > 0 && reserveToken > 0, "Pool: no liquidity");

        uint256 ethIn        = msg.value;
        uint256 ethInWithFee = ethIn * FEE_NUMERATOR;

        // x*y=k formula with fee
        tokenOut = (ethInWithFee * reserveToken) /
                   ((reserveETH * FEE_DENOMINATOR) + ethInWithFee);

        require(tokenOut >= _minTokenOut, "Pool: slippage too high");
        require(tokenOut <  reserveToken, "Pool: insufficient token reserve");

        reserveETH   += ethIn;
        reserveToken -= tokenOut;

        require(psxToken.transfer(exchange, tokenOut), "Pool: token transfer failed");

        emit SwapETHForToken(_trader, ethIn, tokenOut);
    }

    // ─────────────────────────────────────────────
    //  Swap Token → ETH
    // ─────────────────────────────────────────────

    /**
     * @notice Swap share tokens for ETH. Tokens must already be in this contract.
     * @param _trader    Seller address (event log only)
     * @param _tokenIn   Token amount already in this contract
     * @param _minETHOut Minimum ETH out — pass 0 if exchange pre-checked
     * @return ethOut    ETH transferred to exchange
     */
    function swapTokenForETH(address _trader, uint256 _tokenIn, uint256 _minETHOut)
        external onlyExchange nonReentrant
        returns (uint256 ethOut)
    {
        require(_tokenIn > 0, "Pool: token amount must be > 0");
        require(reserveETH > 0 && reserveToken > 0, "Pool: no liquidity");

        uint256 tokenInWithFee = _tokenIn * FEE_NUMERATOR;

        // x*y=k formula with fee
        ethOut = (tokenInWithFee * reserveETH) /
                 ((reserveToken * FEE_DENOMINATOR) + tokenInWithFee);

        require(ethOut >= _minETHOut, "Pool: slippage too high");
        require(ethOut <  reserveETH, "Pool: insufficient ETH reserve");

        reserveToken += _tokenIn;
        reserveETH   -= ethOut;

        // Return ETH to exchange (exchange forwards to seller)
        (bool ok, ) = exchange.call{value: ethOut}("");
        require(ok, "Pool: ETH transfer to exchange failed");

        emit SwapTokenForETH(_trader, _tokenIn, ethOut);
    }

    // ─────────────────────────────────────────────
    //  Price Quotes (view — no gas cost)
    // ─────────────────────────────────────────────

    function quoteETHForToken(uint256 _ethIn) external view returns (uint256 tokenOut) {
        require(reserveETH > 0 && reserveToken > 0, "Pool: no liquidity");
        uint256 ethInWithFee = _ethIn * FEE_NUMERATOR;
        tokenOut = (ethInWithFee * reserveToken) /
                   ((reserveETH * FEE_DENOMINATOR) + ethInWithFee);
    }

    function quoteTokenForETH(uint256 _tokenIn) external view returns (uint256 ethOut) {
        require(reserveETH > 0 && reserveToken > 0, "Pool: no liquidity");
        uint256 tokenInWithFee = _tokenIn * FEE_NUMERATOR;
        ethOut = (tokenInWithFee * reserveETH) /
                 ((reserveToken * FEE_DENOMINATOR) + tokenInWithFee);
    }

    /// @notice Tokens per 1 ETH at current reserves (scaled 1e18)
    function tokenPriceInETH() external view returns (uint256) {
        require(reserveETH > 0, "Pool: no liquidity");
        return (reserveToken * 1e18) / reserveETH;
    }

    function getReserves() external view returns (uint256 ethReserve, uint256 tokenReserve) {
        return (reserveETH, reserveToken);
    }

    // ─────────────────────────────────────────────
    //  Internal Math
    // ─────────────────────────────────────────────

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) {
            z = 1;
        }
    }

    receive() external payable {}
}