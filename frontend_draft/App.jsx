import { useState, useEffect, createContext, useContext } from "react";
import { ethers } from "ethers";

// ─── Contexts ────────────────────────────────────────────────────────────────

export const ThemeContext = createContext();
export const AuthContext  = createContext();

export function useTheme() { return useContext(ThemeContext); }
export function useAuth()  { return useContext(AuthContext);  }

// ─── Contract ABIs (minimal — only functions used by the frontend) ────────────

const FACTORY_ABI = [
  "function getAllTickers() view returns (string[])",
  "function getCompanyInfo(string) view returns (tuple(string companyName, string ticker, string sector, address tokenAddress, uint256 listedAt, bool isActive))",
  "function getTokenAddress(string) view returns (address)",
  "function listCompany(string,string,string,uint256) returns (address)",
  "function delistCompany(string)",
  "function admin() view returns (address)",
];

const EXCHANGE_ABI = [
  "function createPool(string) returns (address)",
  "function buyShares(address,uint256) payable",
  "function sellShares(address,uint256,uint256)",
  "function addLiquidity(address,uint256,uint256) payable",
  "function removeLiquidity(address,uint256,uint256,uint256)",
  "function getPool(address) view returns (address)",
  "function quoteBuy(address,uint256) view returns (uint256)",
  "function quoteSell(address,uint256) view returns (uint256)",
  "function getReserves(address) view returns (uint256,uint256)",
  "function platformFeeBalance() view returns (uint256)",
  "function withdrawPlatformFees(address)",
  "function admin() view returns (address)",
  "function totalPools() view returns (uint256)",
];

const ORACLE_ABI = [
  "function getPrice(string) view returns (uint256,bool)",
  "function getLatestPrice(string) view returns (uint256,uint256,uint256)",
  "function isStale(string) view returns (bool)",
  "function getAllTickers() view returns (string[])",
  "function admin() view returns (address)",
  "function isFeeder(address) view returns (bool)",
];

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function whitelisted(address) view returns (bool)",
  "function setWhitelist(address,bool)",
  "function batchWhitelist(address[],bool)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ─── Contract Addresses — fill after deployment ───────────────────────────────

export const CONTRACTS = {
  factory:  import.meta.env.VITE_FACTORY_ADDRESS  || "",
  exchange: import.meta.env.VITE_EXCHANGE_ADDRESS || "",
  oracle:   import.meta.env.VITE_ORACLE_ADDRESS   || "",
};

// ─── Validate contract configuration ─────────────────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isValidAddress(addr) {
  return addr && addr !== "" && addr !== ZERO_ADDRESS && ethers.isAddress(addr);
}

export function contractsConfigured() {
  return (
    isValidAddress(CONTRACTS.factory)  &&
    isValidAddress(CONTRACTS.exchange) &&
    isValidAddress(CONTRACTS.oracle)
  );
}

// ─── Network config — update EXPECTED_CHAIN_ID for Sepolia (11155111) ────────

const EXPECTED_CHAIN_ID   = 31337;       // Hardhat local
const EXPECTED_CHAIN_NAME = "Hardhat Local";
// For Sepolia deployment change to:
// const EXPECTED_CHAIN_ID   = 11155111;
// const EXPECTED_CHAIN_NAME = "Sepolia";

export const ABIS = { FACTORY_ABI, EXCHANGE_ABI, ORACLE_ABI, TOKEN_ABI };

// ─── Role detection — never throws ───────────────────────────────────────────

async function detectRole(address, provider) {
  if (!contractsConfigured()) return "investor";
  try {
    const factory  = new ethers.Contract(CONTRACTS.factory,  FACTORY_ABI,  provider);
    const exchange = new ethers.Contract(CONTRACTS.exchange, EXCHANGE_ABI, provider);
    const oracle   = new ethers.Contract(CONTRACTS.oracle,   ORACLE_ABI,   provider);

    // Each call is individually guarded — one failure won't block the rest
    const [factAdmin, exchAdmin, isFeeder] = await Promise.all([
      factory.admin().catch(() => null),
      exchange.admin().catch(() => null),
      oracle.isFeeder(address).catch(() => false),
    ]);

    const addr = address.toLowerCase();
    if (factAdmin && addr === factAdmin.toLowerCase()) return "admin";
    if (exchAdmin && addr === exchAdmin.toLowerCase()) return "admin";
    if (isFeeder) return "kyc_checker";
    return "investor";
  } catch {
    return "investor";
  }
}

// ─── Not Configured Screen ────────────────────────────────────────────────────

function NotConfigured() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
      <div style={{ maxWidth: 480, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚙️</div>
        <h2 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: 12 }}>Contracts Not Configured</h2>
        <p style={{ color: "var(--text2)", fontSize: 14, lineHeight: 1.8, marginBottom: "1.5rem" }}>
          Your <code style={{ background: "var(--bg3)", padding: "2px 6px", borderRadius: 4 }}>frontend/.env</code> file is missing or has empty contract addresses.
        </p>
        <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "1.25rem", textAlign: "left", fontFamily: "'DM Mono', monospace", fontSize: 13, lineHeight: 2, color: "var(--text2)" }}>
          <div style={{ color: "var(--text3)", marginBottom: 4 }}># frontend/.env</div>
          <div><span style={{ color: "var(--accent)" }}>VITE_FACTORY_ADDRESS</span>=0x...</div>
          <div><span style={{ color: "var(--accent)" }}>VITE_EXCHANGE_ADDRESS</span>=0x...</div>
          <div><span style={{ color: "var(--accent)" }}>VITE_ORACLE_ADDRESS</span>=0x...</div>
        </div>
        <p style={{ color: "var(--text3)", fontSize: 13, marginTop: "1rem" }}>
          After editing .env, restart the dev server with <code style={{ background: "var(--bg3)", padding: "2px 6px", borderRadius: 4 }}>npm run dev</code>
        </p>
      </div>
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem("psx_theme") || "dark");
  const [auth,  setAuth]  = useState({ connected: false, address: null, role: null, provider: null, signer: null });
  const [page,  setPage]  = useState("landing");
  const [notification, setNotification] = useState(null);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("psx_theme", next);
  };

  const notify = (msg, type = "info") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 5000);
  };

  const connectWallet = async () => {
    // Guard 1: MetaMask installed?
    if (!window.ethereum) {
      notify("MetaMask not found. Install it from metamask.io", "error");
      return;
    }
    // Guard 2: contracts configured?
    if (!contractsConfigured()) {
      notify("Contract addresses not set in .env — restart dev server after editing.", "error");
      return;
    }
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      const provider = new ethers.BrowserProvider(window.ethereum);
      const network  = await provider.getNetwork();
      const chainId  = Number(network.chainId);

      // Guard 3: correct network?
      if (chainId !== EXPECTED_CHAIN_ID) {
        notify(
          `Wrong network (chain ${chainId}). Switch MetaMask to ${EXPECTED_CHAIN_NAME} (chain ID ${EXPECTED_CHAIN_ID}).`,
          "error"
        );
        return;
      }

      const signer  = await provider.getSigner();
      const address = await signer.getAddress();
      const role    = await detectRole(address, provider);

      setAuth({ connected: true, address, role, provider, signer });
      setPage(role === "admin" ? "admin" : role === "kyc_checker" ? "kyc" : "dashboard");
      notify(`Connected as ${role}`, "success");

    } catch (e) {
      if (e.code === 4001) {
        notify("Connection rejected. Approve the MetaMask request to continue.", "error");
      } else {
        notify(e.message || "Connection failed", "error");
      }
    }
  };

  // React to MetaMask account/network changes
  useEffect(() => {
    if (!window.ethereum) return;
    const onAccountChange = () => {
      if (auth.connected) {
        setAuth({ connected: false, address: null, role: null, provider: null, signer: null });
        setPage("landing");
        notify("Account changed — please reconnect.", "warning");
      }
    };
    const onChainChange = () => window.location.reload();
    window.ethereum.on("accountsChanged", onAccountChange);
    window.ethereum.on("chainChanged",    onChainChange);
    return () => {
      window.ethereum.removeListener("accountsChanged", onAccountChange);
      window.ethereum.removeListener("chainChanged",    onChainChange);
    };
  }, [auth.connected]);

  const disconnect = () => {
    setAuth({ connected: false, address: null, role: null, provider: null, signer: null });
    setPage("landing");
  };

  // CSS variables driven by theme
  const cssVars = theme === "dark" ? {
    "--bg":        "#0a0b0f",
    "--bg2":       "#111318",
    "--bg3":       "#1a1d26",
    "--border":    "#ffffff10",
    "--border2":   "#ffffff18",
    "--text":      "#e8eaf0",
    "--text2":     "#8b90a0",
    "--text3":     "#555a6e",
    "--accent":    "#00d4aa",
    "--accent2":   "#0099cc",
    "--danger":    "#ff4d6d",
    "--success":   "#00d4aa",
    "--warning":   "#f5a623",
    "--card":      "#111318",
    "--shadow":    "0 4px 24px rgba(0,0,0,0.5)",
  } : {
    "--bg":        "#f0f2f7",
    "--bg2":       "#ffffff",
    "--bg3":       "#e8eaf0",
    "--border":    "#00000010",
    "--border2":   "#00000018",
    "--text":      "#0d0f1a",
    "--text2":     "#5a6070",
    "--text3":     "#a0a8b8",
    "--accent":    "#007a63",
    "--accent2":   "#0070a0",
    "--danger":    "#cc2244",
    "--success":   "#007a63",
    "--warning":   "#c47a00",
    "--card":      "#ffffff",
    "--shadow":    "0 4px 24px rgba(0,0,0,0.08)",
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <AuthContext.Provider value={{ ...auth, connectWallet, disconnect, notify }}>
        <div style={{ ...cssVars, background: "var(--bg)", color: "var(--text)", minHeight: "100vh", fontFamily: "'DM Sans', sans-serif", transition: "all 0.3s" }}>

          {/* Google Font */}
          <style>{`
            @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap');
            * { box-sizing: border-box; margin: 0; padding: 0; }
            ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: var(--bg2); } ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }
            input, select, textarea { font-family: inherit; }
            button { font-family: inherit; cursor: pointer; }
            a { color: inherit; text-decoration: none; }
          `}</style>

          {/* Navbar */}
          {auth.connected && <Navbar page={page} setPage={setPage} />}

          {/* Notification toast */}
          {notification && <Toast msg={notification.msg} type={notification.type} />}

          {/* Page routing */}
          {!contractsConfigured() && <NotConfigured />}
          {contractsConfigured() && !auth.connected && <LandingPage />}
          {auth.connected && page === "dashboard"  && <DashboardPage />}
          {auth.connected && page === "market"      && <MarketPage />}
          {auth.connected && page === "kyc_apply"   && <KYCApplyPage />}
          {auth.connected && page === "admin"       && auth.role === "admin"       && <AdminPage />}
          {auth.connected && page === "kyc"         && auth.role === "kyc_checker" && <KYCReviewPage />}
          {auth.connected && page === "admin"       && auth.role !== "admin"       && <Unauthorized />}
          {auth.connected && page === "kyc"         && auth.role !== "kyc_checker" && <Unauthorized />}
        </div>
      </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}

// ─── Navbar ───────────────────────────────────────────────────────────────────

function Navbar({ page, setPage }) {
  const { address, role, disconnect } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const navLinks = [
    { id: "dashboard", label: "Portfolio",  roles: ["investor", "admin"] },
    { id: "market",    label: "Market",     roles: ["investor", "admin"] },
    { id: "kyc_apply", label: "KYC",        roles: ["investor"] },
    { id: "admin",     label: "Admin",      roles: ["admin"] },
    { id: "kyc",       label: "KYC Review", roles: ["kyc_checker"] },
  ];

  return (
    <nav style={{ background: "var(--bg2)", borderBottom: "1px solid var(--border)", padding: "0 2rem", display: "flex", alignItems: "center", height: 60, gap: "2rem", position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(10px)" }}>
      {/* Logo */}
      <div style={{ fontFamily: "'DM Mono', monospace", fontWeight: 500, fontSize: 15, color: "var(--accent)", letterSpacing: "0.05em", flexShrink: 0 }}>
        PSX<span style={{ color: "var(--text2)" }}>://</span>chain
      </div>

      {/* Links */}
      <div style={{ display: "flex", gap: "0.25rem", flex: 1 }}>
        {navLinks.filter(l => l.roles.includes(role)).map(l => (
          <button key={l.id} onClick={() => setPage(l.id)} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: page === l.id ? "var(--accent)" + "22" : "transparent", color: page === l.id ? "var(--accent)" : "var(--text2)", fontWeight: page === l.id ? 600 : 400, fontSize: 14, transition: "all 0.15s", cursor: "pointer" }}>
            {l.label}
          </button>
        ))}
      </div>

      {/* Right side */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <RolePill role={role} />
        <button onClick={toggleTheme} title="Toggle theme" style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text2)", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--text3)", background: "var(--bg3)", padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)" }}>
          {address?.slice(0, 6)}…{address?.slice(-4)}
        </div>
        <button onClick={disconnect} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border2)", background: "transparent", color: "var(--text2)", fontSize: 13 }}>
          Disconnect
        </button>
      </div>
    </nav>
  );
}

function RolePill({ role }) {
  const colors = { admin: "#f5a623", kyc_checker: "#0099cc", investor: "#00d4aa" };
  const labels = { admin: "Admin", kyc_checker: "KYC Checker", investor: "Investor" };
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, background: (colors[role] || "#888") + "22", color: colors[role] || "#888", border: `1px solid ${(colors[role] || "#888")}44`, letterSpacing: "0.05em", textTransform: "uppercase" }}>
      {labels[role] || role}
    </span>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, type }) {
  const colors = { success: "var(--success)", error: "var(--danger)", info: "var(--accent2)", warning: "var(--warning)" };
  return (
    <div style={{ position: "fixed", top: 72, right: 24, zIndex: 999, background: "var(--bg2)", border: `1px solid ${colors[type] || "var(--border2)"}`, borderLeft: `4px solid ${colors[type] || "var(--accent)"}`, padding: "12px 18px", borderRadius: 10, boxShadow: "var(--shadow)", maxWidth: 360, fontSize: 14, color: "var(--text)", animation: "fadeIn 0.2s ease" }}>
      <style>{`@keyframes fadeIn { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }`}</style>
      {msg}
    </div>
  );
}

// ─── Landing Page ─────────────────────────────────────────────────────────────

function LandingPage() {
  const { connectWallet } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "2rem", position: "relative", overflow: "hidden" }}>
      {/* Background grid */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: `radial-gradient(circle at 1px 1px, var(--border2) 1px, transparent 0)`, backgroundSize: "40px 40px", opacity: 0.6 }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 80% 60% at 50% 40%, var(--accent)08 0%, transparent 70%)" }} />

      {/* Theme toggle */}
      <button onClick={toggleTheme} style={{ position: "absolute", top: 24, right: 24, width: 38, height: 38, borderRadius: 10, border: "1px solid var(--border2)", background: "var(--bg2)", color: "var(--text2)", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
        {theme === "dark" ? "☀️" : "🌙"}
      </button>

      <div style={{ position: "relative", textAlign: "center", maxWidth: 560 }}>
        {/* Logo */}
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "var(--accent)", letterSpacing: "0.2em", marginBottom: "1.5rem", textTransform: "uppercase" }}>
          Pakistan Stock Exchange
        </div>

        <h1 style={{ fontSize: "clamp(2.5rem, 6vw, 4rem)", fontWeight: 700, lineHeight: 1.1, marginBottom: "1.25rem", letterSpacing: "-0.02em" }}>
          Trade PSX Stocks<br />
          <span style={{ color: "var(--accent)" }}>On-Chain</span>
        </h1>

        <p style={{ color: "var(--text2)", fontSize: "1.1rem", lineHeight: 1.7, marginBottom: "2.5rem" }}>
          Tokenized PSX shares on Ethereum. Buy fractions of OGDC, HBL, PSO and more — 24/7, globally, with instant settlement.
        </p>

        <button onClick={connectWallet} style={{ padding: "14px 32px", borderRadius: 12, border: "none", background: "var(--accent)", color: "#fff", fontWeight: 600, fontSize: 16, cursor: "pointer", transition: "all 0.2s", boxShadow: "0 0 32px var(--accent)44", letterSpacing: "0.01em" }}
          onMouseEnter={e => e.target.style.transform = "translateY(-2px)"}
          onMouseLeave={e => e.target.style.transform = "translateY(0)"}>
          🦊 Connect MetaMask
        </button>

        <div style={{ marginTop: "3rem", display: "flex", justifyContent: "center", gap: "2rem", flexWrap: "wrap" }}>
          {[["AMM Pools", "x·y=k price discovery"], ["KYC Gated", "Compliant investing"], ["Oracle Prices", "Yahoo Finance feeds"]].map(([title, desc]) => (
            <div key={title} style={{ textAlign: "left", padding: "16px 20px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, minWidth: 140 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{title}</div>
              <div style={{ fontSize: 12, color: "var(--text2)" }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Shared UI Components ─────────────────────────────────────────────────────

export function Card({ children, style = {} }) {
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 14, padding: "1.5rem", boxShadow: "var(--shadow)", ...style }}>
      {children}
    </div>
  );
}

export function PageWrapper({ children, title, subtitle }) {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "2rem 1.5rem" }}>
      {(title || subtitle) && (
        <div style={{ marginBottom: "2rem" }}>
          {title    && <h1 style={{ fontSize: "1.75rem", fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>{title}</h1>}
          {subtitle && <p style={{ color: "var(--text2)", fontSize: 15 }}>{subtitle}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

export function StatBox({ label, value, sub, accent }) {
  return (
    <Card style={{ flex: 1, minWidth: 160 }}>
      <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: "1.6rem", fontWeight: 700, color: accent ? "var(--accent)" : "var(--text)", letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>{sub}</div>}
    </Card>
  );
}

export function Btn({ children, onClick, variant = "primary", size = "md", disabled, style = {} }) {
  const styles = {
    primary:   { background: "var(--accent)",  color: "#fff",           border: "none" },
    secondary: { background: "var(--bg3)",     color: "var(--text)",    border: "1px solid var(--border2)" },
    danger:    { background: "var(--danger)",  color: "#fff",           border: "none" },
    ghost:     { background: "transparent",    color: "var(--text2)",   border: "1px solid var(--border)" },
  };
  const sizes = {
    sm: { padding: "6px 14px",  fontSize: 13, borderRadius: 8 },
    md: { padding: "10px 20px", fontSize: 14, borderRadius: 10 },
    lg: { padding: "13px 28px", fontSize: 15, borderRadius: 12 },
  };
  return (
    <button disabled={disabled} onClick={onClick}
      style={{ fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, transition: "all 0.15s", ...styles[variant], ...sizes[size], ...style }}>
      {children}
    </button>
  );
}

export function Input({ label, value, onChange, type = "text", placeholder, unit }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label && <label style={{ fontSize: 13, color: "var(--text2)", fontWeight: 500 }}>{label}</label>}
      <div style={{ position: "relative" }}>
        <input value={value} onChange={e => onChange(e.target.value)} type={type} placeholder={placeholder}
          style={{ width: "100%", padding: unit ? "10px 48px 10px 14px" : "10px 14px", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: 10, color: "var(--text)", fontSize: 14, outline: "none" }} />
        {unit && <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: "var(--text3)", fontFamily: "'DM Mono', monospace" }}>{unit}</span>}
      </div>
    </div>
  );
}

export function Badge({ children, color = "var(--accent)" }) {
  return (
    <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: color + "22", color, border: `1px solid ${color}44` }}>
      {children}
    </span>
  );
}

function Unauthorized() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 48 }}>🚫</div>
      <h2 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Access Denied</h2>
      <p style={{ color: "var(--text2)" }}>You don't have permission to view this page.</p>
    </div>
  );
}

// ─── Dashboard Page ───────────────────────────────────────────────────────────

function DashboardPage() {
  const { provider, signer, address, notify } = useAuth();
  const [holdings,   setHoldings]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [totalValue, setTotalValue] = useState(0n);

  useEffect(() => {
    if (provider && address) loadHoldings();
  }, [provider, address]);

  async function loadHoldings() {
    setLoading(true);
    try {
      const factory  = new ethers.Contract(CONTRACTS.factory,  FACTORY_ABI,  provider);
      const oracle   = new ethers.Contract(CONTRACTS.oracle,   ORACLE_ABI,   provider);
      const tickers  = await factory.getAllTickers();

      const results = await Promise.all(tickers.map(async (ticker) => {
        const info    = await factory.getCompanyInfo(ticker);
        if (!info.isActive) return null;
        const token   = new ethers.Contract(info.tokenAddress, TOKEN_ABI, provider);
        const balance = await token.balanceOf(address);
        if (balance === 0n) return null;

        let price = 0n, isFresh = false;
        try { [price, isFresh] = await oracle.getPrice(ticker); } catch {}

        return { ticker, name: info.companyName, sector: info.sector, tokenAddress: info.tokenAddress, balance, price, isFresh };
      }));

      const filtered = results.filter(Boolean);
      setHoldings(filtered);
      const tv = filtered.reduce((acc, h) => acc + (h.balance * h.price) / (10n ** 26n), 0n);
      setTotalValue(tv);
    } catch (e) {
      notify("Failed to load portfolio: " + e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  const fmt = (wei, dec = 18) => parseFloat(ethers.formatUnits(wei, dec)).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmtPKR = (scaled1e8) => "Rs. " + (Number(scaled1e8) / 1e8).toLocaleString("en-PK", { maximumFractionDigits: 2 });

  return (
    <PageWrapper title="My Portfolio" subtitle="Your tokenized PSX stock holdings">
      {/* Stats row */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "2rem", flexWrap: "wrap" }}>
        <StatBox label="Holdings" value={holdings.length} sub="Active positions" />
        <StatBox label="Portfolio Value" value={holdings.length ? "~" + totalValue.toString() + " PKR" : "—"} sub="Oracle price estimate" accent />
        <StatBox label="Wallet" value={address?.slice(0, 6) + "…" + address?.slice(-4)} sub="Connected address" />
        <StatBox label="Network" value="Sepolia" sub="Ethereum testnet" />
      </div>

      {/* Holdings table */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600 }}>Holdings</h2>
          <Btn size="sm" variant="secondary" onClick={loadHoldings}>↻ Refresh</Btn>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "var(--text2)" }}>Loading portfolio…</div>
        ) : holdings.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
            <p style={{ color: "var(--text2)" }}>No holdings yet. Head to the Market to buy shares.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Stock", "Sector", "Balance", "Oracle Price", "Est. Value", "Status"].map(h => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left", color: "var(--text2)", fontWeight: 500, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {holdings.map((h, i) => (
                  <tr key={h.ticker} style={{ borderBottom: i < holdings.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <td style={{ padding: "14px 12px" }}>
                      <div style={{ fontWeight: 600, fontFamily: "'DM Mono', monospace" }}>{h.ticker}</div>
                      <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>{h.name}</div>
                    </td>
                    <td style={{ padding: "14px 12px" }}><Badge>{h.sector}</Badge></td>
                    <td style={{ padding: "14px 12px", fontFamily: "'DM Mono', monospace" }}>{fmt(h.balance)}</td>
                    <td style={{ padding: "14px 12px", fontFamily: "'DM Mono', monospace" }}>{h.price ? fmtPKR(h.price) : "—"}</td>
                    <td style={{ padding: "14px 12px", fontFamily: "'DM Mono', monospace", color: "var(--accent)" }}>—</td>
                    <td style={{ padding: "14px 12px" }}>
                      <Badge color={h.isFresh ? "var(--success)" : "var(--warning)"}>
                        {h.isFresh ? "Live" : "Stale"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* KYC status */}
      <KYCStatusCard />
    </PageWrapper>
  );
}

function KYCStatusCard() {
  const { provider, address } = useAuth();
  const [statuses, setStatuses] = useState({});

  useEffect(() => {
    if (!provider || !address) return;
    (async () => {
      const factory = new ethers.Contract(CONTRACTS.factory, FACTORY_ABI, provider);
      const tickers = await factory.getAllTickers();
      const checks = await Promise.all(tickers.map(async t => {
        const info  = await factory.getCompanyInfo(t);
        const token = new ethers.Contract(info.tokenAddress, TOKEN_ABI, provider);
        const ok    = await token.whitelisted(address);
        return [t, ok];
      }));
      setStatuses(Object.fromEntries(checks));
    })().catch(() => {});
  }, [provider, address]);

  const approved = Object.values(statuses).filter(Boolean).length;
  const total    = Object.keys(statuses).length;

  return (
    <Card style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "1rem" }}>KYC Status</h2>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <div style={{ flex: 1, height: 8, background: "var(--bg3)", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ height: "100%", width: total ? `${(approved / total) * 100}%` : "0%", background: "var(--accent)", borderRadius: 4, transition: "width 0.5s" }} />
        </div>
        <span style={{ fontSize: 13, color: "var(--text2)", fontFamily: "'DM Mono', monospace" }}>{approved}/{total} approved</span>
      </div>
      {approved < total && (
        <p style={{ fontSize: 13, color: "var(--text2)", marginTop: 10 }}>
          You are not approved for some stocks. Apply for KYC on the KYC page to trade them.
        </p>
      )}
    </Card>
  );
}

// ─── Market Page ──────────────────────────────────────────────────────────────

function MarketPage() {
  const { provider, signer, address, notify } = useAuth();
  const [stocks,     setStocks]     = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [selected,   setSelected]   = useState(null);
  const [tradeMode,  setTradeMode]  = useState("buy");
  const [amount,     setAmount]     = useState("");
  const [quote,      setQuote]      = useState(null);
  const [trading,    setTrading]    = useState(false);
  const [search,     setSearch]     = useState("");

  useEffect(() => { if (provider) loadStocks(); }, [provider]);

  async function loadStocks() {
    setLoading(true);
    try {
      const factory  = new ethers.Contract(CONTRACTS.factory,  FACTORY_ABI,  provider);
      const exchange = new ethers.Contract(CONTRACTS.exchange, EXCHANGE_ABI, provider);
      const oracle   = new ethers.Contract(CONTRACTS.oracle,   ORACLE_ABI,   provider);
      const tickers  = await factory.getAllTickers();

      const results = await Promise.all(tickers.map(async (ticker) => {
        const info = await factory.getCompanyInfo(ticker);
        if (!info.isActive) return null;

        let price = 0n, isFresh = false, ethRes = 0n, tokRes = 0n;
        try { [price, isFresh] = await oracle.getPrice(ticker); } catch {}
        try { [ethRes, tokRes] = await exchange.getReserves(info.tokenAddress); } catch {}

        const token    = new ethers.Contract(info.tokenAddress, TOKEN_ABI, provider);
        const balance  = address ? await token.balanceOf(address) : 0n;
        const isKYC    = address ? await token.whitelisted(address) : false;
        const poolAddr = await exchange.getPool(info.tokenAddress);
        const hasPool  = poolAddr !== ethers.ZeroAddress;

        return { ...info, ticker, price, isFresh, ethRes, tokRes, balance, isKYC, hasPool };
      }));

      setStocks(results.filter(Boolean));
    } catch (e) {
      notify("Failed to load market: " + e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function getQuote() {
    if (!selected || !amount || !provider) return;
    const exchange = new ethers.Contract(CONTRACTS.exchange, EXCHANGE_ABI, provider);
    try {
      if (tradeMode === "buy") {
        const ethIn = ethers.parseEther(amount);
        const out   = await exchange.quoteBuy(selected.tokenAddress, ethIn);
        setQuote({ label: "Tokens you receive", value: ethers.formatEther(out), unit: selected.ticker });
      } else {
        const tokIn = ethers.parseEther(amount);
        const out   = await exchange.quoteSell(selected.tokenAddress, tokIn);
        setQuote({ label: "ETH you receive", value: ethers.formatEther(out), unit: "ETH" });
      }
    } catch { setQuote(null); }
  }

  useEffect(() => { if (amount) getQuote(); else setQuote(null); }, [amount, tradeMode, selected]);

  async function executeTrade() {
    if (!signer || !selected || !amount) return;
    setTrading(true);
    try {
      const exchange = new ethers.Contract(CONTRACTS.exchange, EXCHANGE_ABI, signer);
      if (tradeMode === "buy") {
        const tx = await exchange.buyShares(selected.tokenAddress, 0n, { value: ethers.parseEther(amount) });
        await tx.wait();
        notify(`✅ Bought ${selected.ticker} successfully!`, "success");
      } else {
        const tokAmt = ethers.parseEther(amount);
        const token  = new ethers.Contract(selected.tokenAddress, TOKEN_ABI, signer);
        const appTx  = await token.approve(CONTRACTS.exchange, tokAmt);
        await appTx.wait();
        const tx = await exchange.sellShares(selected.tokenAddress, tokAmt, 0n);
        await tx.wait();
        notify(`✅ Sold ${selected.ticker} successfully!`, "success");
      }
      setAmount(""); setQuote(null);
      loadStocks();
    } catch (e) {
      notify("Trade failed: " + (e.reason || e.message), "error");
    } finally {
      setTrading(false);
    }
  }

  const fmtPKR = (v) => v ? "Rs. " + (Number(v) / 1e8).toLocaleString("en-PK", { maximumFractionDigits: 2 }) : "—";
  const fmtETH = (v) => parseFloat(ethers.formatEther(v)).toFixed(4) + " ETH";
  const filtered = stocks.filter(s => s.ticker.includes(search.toUpperCase()) || s.companyName.toLowerCase().includes(search.toLowerCase()));

  return (
    <PageWrapper title="Market" subtitle="Live PSX tokenized stocks — powered by AMM liquidity pools">
      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>

        {/* Stock list */}
        <div style={{ flex: 2, minWidth: 300 }}>
          <div style={{ marginBottom: "1rem" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search ticker or company…"
              style={{ width: "100%", padding: "10px 16px", background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 10, color: "var(--text)", fontSize: 14, outline: "none" }} />
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: "3rem", color: "var(--text2)" }}>Loading market…</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {filtered.map(s => (
                <Card key={s.ticker} style={{ cursor: "pointer", border: selected?.ticker === s.ticker ? "1px solid var(--accent)" : "1px solid var(--border)", transition: "all 0.15s" }}
                  onClick={() => { setSelected(s); setAmount(""); setQuote(null); }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontWeight: 700, fontFamily: "'DM Mono', monospace", fontSize: 16 }}>{s.ticker}</span>
                        <Badge>{s.sector}</Badge>
                        {!s.isKYC && <Badge color="var(--warning)">KYC Required</Badge>}
                        {!s.hasPool && <Badge color="var(--text3)">No Pool</Badge>}
                      </div>
                      <div style={{ fontSize: 13, color: "var(--text2)" }}>{s.companyName}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontFamily: "'DM Mono', monospace", fontWeight: 600, fontSize: 15, color: "var(--accent)" }}>{fmtPKR(s.price)}</div>
                      <div style={{ fontSize: 11, color: s.isFresh ? "var(--success)" : "var(--warning)", marginTop: 2 }}>{s.isFresh ? "● Live" : "○ Stale"}</div>
                    </div>
                  </div>
                  {s.ethRes > 0n && (
                    <div style={{ marginTop: 10, display: "flex", gap: "1.5rem", fontSize: 12, color: "var(--text3)", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                      <span>Pool ETH: <span style={{ color: "var(--text2)", fontFamily: "'DM Mono', monospace" }}>{fmtETH(s.ethRes)}</span></span>
                      <span>Your balance: <span style={{ color: "var(--text2)", fontFamily: "'DM Mono', monospace" }}>{parseFloat(ethers.formatEther(s.balance)).toFixed(2)}</span></span>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Trade panel */}
        <div style={{ flex: 1, minWidth: 280, position: "sticky", top: 76 }}>
          {!selected ? (
            <Card style={{ textAlign: "center", padding: "3rem 1.5rem" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
              <p style={{ color: "var(--text2)", fontSize: 14 }}>Select a stock from the list to trade</p>
            </Card>
          ) : (
            <Card>
              <div style={{ marginBottom: "1.25rem" }}>
                <div style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700, fontSize: 20 }}>{selected.ticker}</div>
                <div style={{ fontSize: 13, color: "var(--text2)" }}>{selected.companyName}</div>
              </div>

              {/* Price info */}
              <div style={{ background: "var(--bg3)", borderRadius: 10, padding: "12px 14px", marginBottom: "1.25rem" }}>
                <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 4 }}>Oracle Price</div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontWeight: 600, fontSize: 18, color: "var(--accent)" }}>{fmtPKR(selected.price)}</div>
                <div style={{ fontSize: 11, color: selected.isFresh ? "var(--success)" : "var(--warning)", marginTop: 2 }}>{selected.isFresh ? "● Live feed" : "○ Stale — price may be outdated"}</div>
              </div>

              {/* Buy / Sell toggle */}
              <div style={{ display: "flex", background: "var(--bg3)", borderRadius: 10, padding: 4, marginBottom: "1.25rem", gap: 4 }}>
                {["buy", "sell"].map(m => (
                  <button key={m} onClick={() => { setTradeMode(m); setAmount(""); setQuote(null); }}
                    style={{ flex: 1, padding: "8px", borderRadius: 8, border: "none", background: tradeMode === m ? (m === "buy" ? "var(--success)" : "var(--danger)") : "transparent", color: tradeMode === m ? "#fff" : "var(--text2)", fontWeight: 600, fontSize: 14, cursor: "pointer", transition: "all 0.15s", textTransform: "capitalize" }}>
                    {m === "buy" ? "▲ Buy" : "▼ Sell"}
                  </button>
                ))}
              </div>

              {!selected.isKYC ? (
                <div style={{ padding: "12px", background: "var(--warning)11", border: "1px solid var(--warning)44", borderRadius: 10, fontSize: 13, color: "var(--warning)", textAlign: "center" }}>
                  ⚠️ You need KYC approval to trade {selected.ticker}
                </div>
              ) : !selected.hasPool ? (
                <div style={{ padding: "12px", background: "var(--text3)11", border: "1px solid var(--border)", borderRadius: 10, fontSize: 13, color: "var(--text2)", textAlign: "center" }}>
                  No liquidity pool created yet
                </div>
              ) : (
                <>
                  <Input label={tradeMode === "buy" ? "ETH to spend" : `${selected.ticker} to sell`}
                    value={amount} onChange={setAmount} type="number" placeholder="0.0"
                    unit={tradeMode === "buy" ? "ETH" : selected.ticker} />

                  {quote && (
                    <div style={{ marginTop: "0.75rem", background: "var(--accent)11", border: "1px solid var(--accent)33", borderRadius: 10, padding: "12px 14px" }}>
                      <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 4 }}>{quote.label}</div>
                      <div style={{ fontFamily: "'DM Mono', monospace", fontWeight: 600, color: "var(--accent)" }}>
                        {parseFloat(quote.value).toFixed(4)} {quote.unit}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>Includes 0.3% AMM fee + 0.1% platform fee</div>
                    </div>
                  )}

                  <Btn style={{ width: "100%", marginTop: "1rem", justifyContent: "center" }}
                    variant={tradeMode === "buy" ? "primary" : "danger"}
                    onClick={executeTrade} disabled={!amount || trading}>
                    {trading ? "Processing…" : tradeMode === "buy" ? `Buy ${selected.ticker}` : `Sell ${selected.ticker}`}
                  </Btn>
                </>
              )}
            </Card>
          )}
        </div>
      </div>
    </PageWrapper>
  );
}

// ─── KYC Apply Page ───────────────────────────────────────────────────────────

function KYCApplyPage() {
  const { provider, signer, address, notify } = useAuth();
  const [stocks,    setStocks]    = useState([]);
  const [form,      setForm]      = useState({ fullName: "", cnic: "", email: "", phone: "" });
  const [selected,  setSelected]  = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]  = useState(false);

  useEffect(() => { if (provider) loadStocks(); }, [provider]);

  async function loadStocks() {
    const factory = new ethers.Contract(CONTRACTS.factory, FACTORY_ABI, provider);
    const tickers = await factory.getAllTickers();
    const results = await Promise.all(tickers.map(async t => {
      const info  = await factory.getCompanyInfo(t);
      const token = new ethers.Contract(info.tokenAddress, TOKEN_ABI, provider);
      const ok    = await token.whitelisted(address);
      return { ticker: t, name: info.companyName, tokenAddress: info.tokenAddress, isActive: info.isActive, approved: ok };
    }));
    setStocks(results.filter(r => r.isActive));
  }

  function toggleSelect(ticker) {
    setSelected(prev => prev.includes(ticker) ? prev.filter(t => t !== ticker) : [...prev, ticker]);
  }

  async function handleSubmit() {
    if (!form.fullName || !form.cnic || !form.email) { notify("Please fill in all required fields", "error"); return; }
    if (selected.length === 0) { notify("Select at least one stock to apply for", "error"); return; }

    setSubmitting(true);
    try {
      // Store KYC request in localStorage (in production: backend API)
      const requests = JSON.parse(localStorage.getItem("kyc_requests") || "[]");
      requests.push({ ...form, address, tickers: selected, status: "pending", submittedAt: Date.now(), id: Date.now().toString() });
      localStorage.setItem("kyc_requests", JSON.stringify(requests));
      setSubmitted(true);
      notify("KYC application submitted successfully!", "success");
    } catch (e) {
      notify("Submission failed: " + e.message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) return (
    <PageWrapper title="KYC Application">
      <Card style={{ maxWidth: 500, margin: "4rem auto", textAlign: "center", padding: "3rem" }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
        <h2 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: 8 }}>Application Submitted</h2>
        <p style={{ color: "var(--text2)", fontSize: 14, lineHeight: 1.7 }}>
          Your KYC application is under review. The KYC team will approve or reject it shortly.
          You will be able to trade once approved.
        </p>
        <Btn style={{ marginTop: "1.5rem" }} onClick={() => { setSubmitted(false); setForm({ fullName: "", cnic: "", email: "", phone: "" }); setSelected([]); }}>
          Submit Another
        </Btn>
      </Card>
    </PageWrapper>
  );

  return (
    <PageWrapper title="KYC Application" subtitle="Complete identity verification to start trading PSX tokenized stocks">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", maxWidth: 900, margin: "0 auto" }}>

        {/* Form */}
        <Card>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1.25rem" }}>Personal Information</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <Input label="Full Name *" value={form.fullName} onChange={v => setForm(f => ({ ...f, fullName: v }))} placeholder="Muhammad Ali Khan" />
            <Input label="CNIC *" value={form.cnic} onChange={v => setForm(f => ({ ...f, cnic: v }))} placeholder="42201-1234567-1" />
            <Input label="Email *" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} type="email" placeholder="investor@email.com" />
            <Input label="Phone" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} placeholder="+92 300 1234567" />
            <div style={{ background: "var(--bg3)", borderRadius: 10, padding: "12px 14px", fontSize: 12, color: "var(--text2)" }}>
              🔒 Wallet: <span style={{ fontFamily: "'DM Mono', monospace", color: "var(--text)" }}>{address}</span>
            </div>
          </div>
        </Card>

        {/* Stock selection */}
        <Card>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1.25rem" }}>Select Stocks to Apply For</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1.5rem" }}>
            {stocks.map(s => (
              <label key={s.ticker} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--bg3)", borderRadius: 10, cursor: s.approved ? "default" : "pointer", opacity: s.approved ? 0.5 : 1, border: selected.includes(s.ticker) ? "1px solid var(--accent)" : "1px solid transparent" }}>
                <input type="checkbox" checked={selected.includes(s.ticker)} disabled={s.approved}
                  onChange={() => !s.approved && toggleSelect(s.ticker)}
                  style={{ accentColor: "var(--accent)", width: 16, height: 16 }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600, fontFamily: "'DM Mono', monospace" }}>{s.ticker}</span>
                  <span style={{ fontSize: 12, color: "var(--text2)", marginLeft: 8 }}>{s.name}</span>
                </div>
                {s.approved && <Badge color="var(--success)">Approved</Badge>}
              </label>
            ))}
          </div>
          <Btn style={{ width: "100%" }} onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Submitting…" : "Submit KYC Application"}
          </Btn>
        </Card>
      </div>
    </PageWrapper>
  );
}

// ─── KYC Review Page ──────────────────────────────────────────────────────────

function KYCReviewPage() {
  const { provider, signer, notify } = useAuth();
  const [requests,   setRequests]   = useState([]);
  const [processing, setProcessing] = useState(null);
  const [filter,     setFilter]     = useState("pending");

  useEffect(() => { loadRequests(); }, []);

  function loadRequests() {
    const all = JSON.parse(localStorage.getItem("kyc_requests") || "[]");
    setRequests(all.sort((a, b) => b.submittedAt - a.submittedAt));
  }

  async function approve(req) {
    setProcessing(req.id);
    try {
      const factory = new ethers.Contract(CONTRACTS.factory, FACTORY_ABI, provider);
      for (const ticker of req.tickers) {
        const tokenAddr = await factory.getTokenAddress(ticker);
        const token = new ethers.Contract(tokenAddr, TOKEN_ABI, signer);
        const tx = await token.setWhitelist(req.address, true);
        await tx.wait();
      }
      updateStatus(req.id, "approved");
      notify(`✅ Approved KYC for ${req.fullName}`, "success");
    } catch (e) {
      notify("Approval failed: " + (e.reason || e.message), "error");
    } finally {
      setProcessing(null);
    }
  }

  function reject(req) {
    updateStatus(req.id, "rejected");
    notify(`KYC rejected for ${req.fullName}`, "warning");
  }

  function updateStatus(id, status) {
    const all = JSON.parse(localStorage.getItem("kyc_requests") || "[]");
    const upd = all.map(r => r.id === id ? { ...r, status, reviewedAt: Date.now() } : r);
    localStorage.setItem("kyc_requests", JSON.stringify(upd));
    setRequests(upd.sort((a, b) => b.submittedAt - a.submittedAt));
  }

  const filtered  = requests.filter(r => r.status === filter);
  const counts    = { pending: requests.filter(r => r.status === "pending").length, approved: requests.filter(r => r.status === "approved").length, rejected: requests.filter(r => r.status === "rejected").length };

  return (
    <PageWrapper title="KYC Review" subtitle="Review and approve investor identity verification requests">
      {/* Stats */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <StatBox label="Pending"  value={counts.pending}  sub="Awaiting review" />
        <StatBox label="Approved" value={counts.approved} sub="Verified investors" accent />
        <StatBox label="Rejected" value={counts.rejected} sub="Failed verification" />
      </div>

      {/* Filter tabs */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        {["pending", "approved", "rejected"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid var(--border2)", background: filter === f ? "var(--accent)" : "var(--bg2)", color: filter === f ? "#fff" : "var(--text2)", fontWeight: filter === f ? 600 : 400, fontSize: 13, cursor: "pointer", textTransform: "capitalize" }}>
            {f} ({counts[f]})
          </button>
        ))}
        <Btn size="sm" variant="secondary" onClick={loadRequests} style={{ marginLeft: "auto" }}>↻ Refresh</Btn>
      </div>

      {/* Requests */}
      {filtered.length === 0 ? (
        <Card style={{ textAlign: "center", padding: "3rem" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
          <p style={{ color: "var(--text2)" }}>No {filter} requests</p>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {filtered.map(req => (
            <Card key={req.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 16 }}>{req.fullName}</span>
                    <Badge color={req.status === "approved" ? "var(--success)" : req.status === "rejected" ? "var(--danger)" : "var(--warning)"}>
                      {req.status}
                    </Badge>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0.5rem", fontSize: 13, color: "var(--text2)" }}>
                    <span>📋 CNIC: <span style={{ color: "var(--text)", fontFamily: "'DM Mono', monospace" }}>{req.cnic}</span></span>
                    <span>📧 Email: <span style={{ color: "var(--text)" }}>{req.email}</span></span>
                    {req.phone && <span>📞 Phone: <span style={{ color: "var(--text)" }}>{req.phone}</span></span>}
                    <span>🕐 Submitted: <span style={{ color: "var(--text)" }}>{new Date(req.submittedAt).toLocaleDateString()}</span></span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--text3)", marginRight: 8 }}>Applied for:</span>
                    {req.tickers.map(t => <Badge key={t} color="var(--accent2)">{t}</Badge>)}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 11, color: "var(--text3)", fontFamily: "'DM Mono', monospace" }}>
                    Wallet: {req.address?.slice(0, 10)}…{req.address?.slice(-6)}
                  </div>
                </div>

                {req.status === "pending" && (
                  <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                    <Btn variant="danger" size="sm" onClick={() => reject(req)} disabled={processing === req.id}>
                      Reject
                    </Btn>
                    <Btn variant="primary" size="sm" onClick={() => approve(req)} disabled={processing === req.id}>
                      {processing === req.id ? "Processing…" : "Approve"}
                    </Btn>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </PageWrapper>
  );
}

// ─── Admin Page ───────────────────────────────────────────────────────────────

function AdminPage() {
  const { provider, signer, notify } = useAuth();
  const [tab,         setTab]         = useState("companies");
  const [companies,   setCompanies]   = useState([]);
  const [form,        setForm]        = useState({ name: "", ticker: "", sector: "", supply: "" });
  const [loading,     setLoading]     = useState(true);
  const [submitting,  setSubmitting]  = useState(false);
  const [feeBalance,  setFeeBalance]  = useState(0n);
  const [withdrawing, setWithdrawing] = useState(false);

  const SECTORS = ["Energy", "Banking", "Cement", "Fertilizer", "Technology", "Textiles", "Automobile", "Chemicals", "Food & Beverage", "Pharmaceuticals", "Insurance", "Other"];

  useEffect(() => { if (provider) loadData(); }, [provider]);

  async function loadData() {
    setLoading(true);
    try {
      const factory  = new ethers.Contract(CONTRACTS.factory,  FACTORY_ABI,  provider);
      const exchange = new ethers.Contract(CONTRACTS.exchange, EXCHANGE_ABI, provider);
      const tickers  = await factory.getAllTickers();

      const results = await Promise.all(tickers.map(async t => {
        const info    = await factory.getCompanyInfo(t);
        const poolAddr = await exchange.getPool(info.tokenAddress);
        const hasPool  = poolAddr !== ethers.ZeroAddress;
        const token    = new ethers.Contract(info.tokenAddress, TOKEN_ABI, provider);
        const supply   = await token.totalSupply();
        return { ...info, ticker: t, hasPool, supply };
      }));

      setCompanies(results);
      setFeeBalance(await exchange.platformFeeBalance());
    } catch (e) {
      notify("Failed to load admin data: " + e.message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function handleListCompany(e) {
    e.preventDefault();
    if (!form.name || !form.ticker || !form.sector || !form.supply) { notify("All fields required", "error"); return; }
    setSubmitting(true);
    try {
      const factory  = new ethers.Contract(CONTRACTS.factory,  FACTORY_ABI,  signer);
      const exchange = new ethers.Contract(CONTRACTS.exchange, EXCHANGE_ABI, signer);

      const tx1 = await factory.listCompany(form.name, form.ticker.toUpperCase(), form.sector, BigInt(form.supply));
      await tx1.wait();
      notify(`✅ ${form.ticker.toUpperCase()} listed! Creating pool…`, "success");

      const tx2 = await exchange.createPool(form.ticker.toUpperCase());
      await tx2.wait();
      notify(`✅ Pool created for ${form.ticker.toUpperCase()}`, "success");

      setForm({ name: "", ticker: "", sector: "", supply: "" });
      loadData();
    } catch (e) {
      notify("Failed: " + (e.reason || e.message), "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelist(ticker) {
    if (!confirm(`Delist ${ticker}? This cannot be undone.`)) return;
    try {
      const factory = new ethers.Contract(CONTRACTS.factory, FACTORY_ABI, signer);
      const tx = await factory.delistCompany(ticker);
      await tx.wait();
      notify(`${ticker} delisted`, "warning");
      loadData();
    } catch (e) {
      notify("Delist failed: " + (e.reason || e.message), "error");
    }
  }

  async function handleCreatePool(ticker) {
    try {
      const exchange = new ethers.Contract(CONTRACTS.exchange, EXCHANGE_ABI, signer);
      const tx = await exchange.createPool(ticker);
      await tx.wait();
      notify(`✅ Pool created for ${ticker}`, "success");
      loadData();
    } catch (e) {
      notify("Pool creation failed: " + (e.reason || e.message), "error");
    }
  }

  async function handleWithdrawFees() {
    setWithdrawing(true);
    try {
      const exchange = new ethers.Contract(CONTRACTS.exchange, EXCHANGE_ABI, signer);
      const addr = await signer.getAddress();
      const tx = await exchange.withdrawPlatformFees(addr);
      await tx.wait();
      notify("✅ Fees withdrawn to your wallet", "success");
      loadData();
    } catch (e) {
      notify("Withdrawal failed: " + (e.reason || e.message), "error");
    } finally {
      setWithdrawing(false);
    }
  }

  const tabs = ["companies", "list_company", "fees"];

  return (
    <PageWrapper title="Admin Panel" subtitle="Manage companies, pools, and platform settings">

      {/* Tab nav */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem", borderBottom: "1px solid var(--border)", paddingBottom: "0.75rem" }}>
        {[["companies", "📋 Companies"], ["list_company", "➕ List Company"], ["fees", "💰 Platform Fees"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding: "8px 16px", borderRadius: "8px 8px 0 0", border: "none", background: tab === id ? "var(--accent)" : "transparent", color: tab === id ? "#fff" : "var(--text2)", fontWeight: tab === id ? 600 : 400, fontSize: 14, cursor: "pointer", transition: "all 0.15s" }}>
            {label}
          </button>
        ))}
      </div>

      {/* Companies tab */}
      {tab === "companies" && (
        loading ? <div style={{ textAlign: "center", padding: "3rem", color: "var(--text2)" }}>Loading…</div> : (
          <Card>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Ticker", "Company", "Sector", "Supply", "Pool", "Status", "Actions"].map(h => (
                      <th key={h} style={{ padding: "10px 12px", textAlign: "left", color: "var(--text2)", fontWeight: 500, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {companies.map((c, i) => (
                    <tr key={c.ticker} style={{ borderBottom: i < companies.length - 1 ? "1px solid var(--border)" : "none" }}>
                      <td style={{ padding: "12px", fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>{c.ticker}</td>
                      <td style={{ padding: "12px", fontSize: 13 }}>{c.companyName}</td>
                      <td style={{ padding: "12px" }}><Badge>{c.sector}</Badge></td>
                      <td style={{ padding: "12px", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{(Number(c.supply) / 1e18).toLocaleString()}</td>
                      <td style={{ padding: "12px" }}>
                        {c.hasPool ? <Badge color="var(--success)">Created</Badge> : (
                          <Btn size="sm" variant="secondary" onClick={() => handleCreatePool(c.ticker)}>Create</Btn>
                        )}
                      </td>
                      <td style={{ padding: "12px" }}>
                        <Badge color={c.isActive ? "var(--success)" : "var(--text3)"}>
                          {c.isActive ? "Active" : "Delisted"}
                        </Badge>
                      </td>
                      <td style={{ padding: "12px" }}>
                        {c.isActive && (
                          <Btn size="sm" variant="danger" onClick={() => handleDelist(c.ticker)}>Delist</Btn>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      )}

      {/* List company tab */}
      {tab === "list_company" && (
        <Card style={{ maxWidth: 560 }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "1.5rem" }}>List a New PSX Company</h2>
          <form onSubmit={handleListCompany}>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <Input label="Company Name *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="Oil & Gas Development Company" />
              <Input label="PSX Ticker *" value={form.ticker} onChange={v => setForm(f => ({ ...f, ticker: v.toUpperCase() }))} placeholder="OGDC" />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 13, color: "var(--text2)", fontWeight: 500 }}>Sector *</label>
                <select value={form.sector} onChange={e => setForm(f => ({ ...f, sector: e.target.value }))}
                  style={{ padding: "10px 14px", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: 10, color: "var(--text)", fontSize: 14, outline: "none" }}>
                  <option value="">Select sector…</option>
                  {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <Input label="Initial Supply (whole shares) *" value={form.supply} onChange={v => setForm(f => ({ ...f, supply: v }))} type="number" placeholder="1000000" unit="shares" />
              <div style={{ background: "var(--bg3)", borderRadius: 10, padding: "12px 14px", fontSize: 12, color: "var(--text2)" }}>
                💡 This will deploy a new ERC-20 token and create a liquidity pool automatically.
              </div>
              <Btn type="submit" disabled={submitting} style={{ alignSelf: "flex-start" }}>
                {submitting ? "Deploying…" : "List Company + Create Pool"}
              </Btn>
            </div>
          </form>
        </Card>
      )}

      {/* Fees tab */}
      {tab === "fees" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 480 }}>
          <StatBox label="Platform Fee Balance" value={parseFloat(ethers.formatEther(feeBalance)).toFixed(6) + " ETH"} sub="Accumulated from 0.1% trading fees" accent />
          <Card>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1rem" }}>Withdraw Fees</h2>
            <p style={{ fontSize: 14, color: "var(--text2)", marginBottom: "1rem", lineHeight: 1.6 }}>
              Withdraw all accumulated platform fees to your connected wallet. This is irreversible.
            </p>
            <Btn onClick={handleWithdrawFees} disabled={withdrawing || feeBalance === 0n}>
              {withdrawing ? "Withdrawing…" : `Withdraw ${parseFloat(ethers.formatEther(feeBalance)).toFixed(4)} ETH`}
            </Btn>
          </Card>
        </div>
      )}
    </PageWrapper>
  );
}