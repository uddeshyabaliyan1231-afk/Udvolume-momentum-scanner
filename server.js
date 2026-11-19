
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const API = "https://public.coindcx.com";
const ACTIVE_API =
  "https://api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT";

const CONFIG = {
  scanInterval: 20000,
  candleLimit: 120,
  volumeMAPeriod: 20,
  flatLookback: 6,
  risingLookback: 3,
  flatTolerance: 0.003,
  minimumRise: 0.004,
  minimumVolumeRatio: 1.15,
  minimumQuoteVolume: 10000,
  minimumOrderbookDepth: 5000,
  maximumSpread: 0.002,
  atrMultiplierSL: 1.5,
  riskReward: 2,
  maxSignals: 20,
  concurrency: 4
};

const EXCLUDED = [
  "BTC", "ETH", "SOL", "BNB", "XRP",
  "DOGE", "ADA", "TRX", "DOT", "LINK",
  "AVAX", "TON", "BCH"
];

const LIMIT_OPTIONS = [100, 200, 500, 1000, "ALL"];

let selectedScanLimit = "ALL";
let signals = [];
let scanning = false;

let scanStatus = {
  running: false,
  scanned: 0,
  totalPairs: 0,
  activePairs: 0,
  errors: 0,
  lastScan: null,
  message: "Initializing scanner"
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sma(values, period) {
  const result = [];

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    const slice = values.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }

  return result;
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = (values[i] - value) * multiplier + value;
  }

  return value;
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  const recent = ranges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function normalizeCandles(data) {
  if (!Array.isArray(data)) return [];

  return data.map(c => {
    if (Array.isArray(c)) {
      return {
        time: num(c[0]),
        open: num(c[1]),
        high: num(c[2]),
        low: num(c[3]),
        close: num(c[4]),
        volume: num(c[5])
      };
    }

    return {
      time: num(c.time ?? c.t),
      open: num(c.open ?? c.o),
      high: num(c.high ?? c.h),
      low: num(c.low ?? c.l),
      close: num(c.close ?? c.c),
      volume: num(c.volume ?? c.v)
    };
  }).filter(c =>
    c.open > 0 &&
    c.high > 0 &&
    c.low > 0 &&
    c.close > 0 &&
    c.volume >= 0
  ).sort((a, b) => a.time - b.time);
}

async function getJSON(url, params = {}) {
  const response = await axios.get(url, {
    params,
    timeout: 15000,
    headers: {
      "User-Agent": "Volume-Momentum-Scanner/2.0"
    }
  });

  return response.data;
}

function formatPair(pair) {
  let p = String(pair).trim().toUpperCase();

  if (p.startsWith("B-")) return p;

  if (p.includes("_")) {
    return "B-" + p;
  }

  if (p.endsWith("USDT")) {
    return "B-" + p.slice(0, -4) + "_USDT";
  }

  return p;
}

function getBaseSymbol(pair) {
  return String(pair)
    .replace(/^B-/, "")
    .replace(/_USDT$/i, "")
    .replace(/USDT$/i, "")
    .toUpperCase();
}

async function getPairs() {
  const data = await getJSON(ACTIVE_API);

  if (!Array.isArray(data)) {
    throw new Error("CoinDCX active instruments response invalid");
  }

  const pairs = data.map(item => {
    if (typeof item === "string") return item;

    return (
      item.pair ||
      item.symbol ||
      item.instrument_name ||
      item.market ||
      ""
    );
  }).filter(Boolean);

  return [...new Set(pairs.map(formatPair))].filter(pair => {
    const base = getBaseSymbol(pair);

    return (
      pair.includes("USDT") &&
      base.length > 0 &&
      !EXCLUDED.includes(base)
    );
  });
}

async function getCandles(pair, interval) {
  const data = await getJSON(
    `${API}/market_data/candles`,
    {
      pair: formatPair(pair),
      interval,
      limit: CONFIG.candleLimit
    }
  );

  return normalizeCandles(data);
}

async function getOrderbook(pair) {
  return await getJSON(
    `${API}/market_data/orderbook`,
    { pair: formatPair(pair) }
  );
}

function analyzeTrend(candles) {
  if (candles.length < 55) return "UNKNOWN";

  const closes = candles.map(c => c.close);

  const fast = ema(closes, 20);
  const slow = ema(closes, 50);

  const previousFast = ema(closes.slice(0, -3), 20);
  const price = closes[closes.length - 1];

  if (
    price > fast &&
    fast > slow &&
    fast > previousFast
  ) {
    return "BULLISH";
  }

  if (
    price < fast &&
    fast < slow &&
    fast < previousFast
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

function detectVolumeExpansion(candles) {
  const volumes = candles.map(c => c.volume);
  const ma = sma(volumes, CONFIG.volumeMAPeriod);

  const valid = ma.filter(v => v !== null);

  const needed =
    CONFIG.flatLookback + CONFIG.risingLookback + 1;

  if (valid.length < needed) return null;

  const latest = valid[valid.length - 1];

  const rising = valid.slice(-CONFIG.risingLookback);
  const flat = valid.slice(
    -(CONFIG.flatLookback + CONFIG.risingLookback + 1),
    -CONFIG.risingLookback
  );

  if (flat.length !== CONFIG.flatLookback) return null;

  const flatAverage =
    flat.reduce((a, b) => a + b, 0) / flat.length;

  if (flatAverage <= 0) return null;

  const flatDeviation =
    (Math.max(...flat) - Math.min(...flat)) / flatAverage;

  if (flatDeviation > CONFIG.flatTolerance) return null;

  for (let i = 1; i < rising.length; i++) {
    if (rising[i] <= rising[i - 1]) return null;
  }

  const risePercent =
    (latest - rising[0]) / rising[0];

  if (risePercent < CONFIG.minimumRise) return null;

  const currentVolume = volumes[volumes.length - 1];
  const previousVolumes = volumes.slice(-21, -1);

  if (previousVolumes.length < 10) return null;

  const averageVolume =
    previousVolumes.reduce((a, b) => a + b, 0) /
    previousVolumes.length;

  const volumeRatio =
    averageVolume > 0 ? currentVolume / averageVolume : 0;

  if (volumeRatio < CONFIG.minimumVolumeRatio) return null;

  return {
    volumeMA: latest,
    risePercent,
    volumeRatio
  };
}

function parseLevels(side) {
  if (!side) return [];

  let raw = side;

  if (
    Array.isArray(side) &&
    side.length === 1 &&
    Array.isArray(side[0])
  ) {
    raw = side[0];
  }

  if (Array.isArray(raw)) {
    return raw.map(level => {
      if (Array.isArray(level)) {
        return {
          price: num(level[0]),
          quantity: num(level[1])
        };
      }

      return {
        price: num(level.price ?? level.rate),
        quantity: num(level.quantity ?? level.amount)
      };
    }).filter(x => x.price > 0 && x.quantity > 0);
  }

  if (typeof raw === "object") {
    return Object.entries(raw).map(([price, quantity]) => ({
      price: num(price),
      quantity: num(quantity)
    })).filter(x => x.price > 0 && x.quantity > 0);
  }

  return [];
}

function checkOrderbook(book, price) {
  if (!book || !price) {
    return { passed: false, reason: "Orderbook unavailable" };
  }

  const data = book.data || book;

  const bids = parseLevels(data.bids);
  const asks = parseLevels(data.asks);

  if (!bids.length || !asks.length) {
    return { passed: false, reason: "Empty orderbook" };
  }

  const bestBid = Math.max(...bids.map(x => x.price));
  const bestAsk = Math.min(...asks.map(x => x.price));

  const spread = (bestAsk - bestBid) / price;

  const bidDepth = bids
    .filter(x => x.price >= price * 0.99)
    .reduce((sum, x) => sum + x.price * x.quantity, 0);

  const askDepth = asks
    .filter(x => x.price <= price * 1.01)
    .reduce((sum, x) => sum + x.price * x.quantity, 0);

  if (
    spread <= 0 ||
    spread > CONFIG.maximumSpread
  ) {
    return { passed: false, reason: "Spread too high" };
  }

  if (
    bidDepth < CONFIG.minimumOrderbookDepth ||
    askDepth < CONFIG.minimumOrderbookDepth
  ) {
    return { passed: false, reason: "Insufficient orderbook depth" };
  }

  return {
    passed: true,
    spread,
    bidDepth,
    askDepth
  };
}

function checkLiquidityTrap(candles, direction) {
  const recent = candles.slice(-8);

  if (recent.length < 8) {
    return { passed: false, reason: "Insufficient history" };
  }

  const last = recent[recent.length - 1];
  const range = last.high - last.low;

  if (range <= 0) {
    return { passed: false, reason: "Invalid candle" };
  }

  const upperWick =
    last.high - Math.max(last.open, last.close);

  const lowerWick =
    Math.min(last.open, last.close) - last.low;

  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;

  if (
    direction === "BUY" &&
    upperWick / range > 0.60
  ) {
    return { passed: false, reason: "Upper wick rejection" };
  }

  if (
    direction === "SELL" &&
    lowerWick / range > 0.60
  ) {
    return { passed: false, reason: "Lower wick rejection" };
  }

  if (bodyRatio < 0.15) {
    return { passed: false, reason: "Weak price follow-through" };
  }

  const previous = recent.slice(0, -1);

  const priorHigh = Math.max(...previous.map(c => c.high));
  const priorLow = Math.min(...previous.map(c => c.low));

  if (
    direction === "BUY" &&
    last.high > priorHigh &&
    last.close < priorHigh
  ) {
    return { passed: false, reason: "Possible buy-side liquidity sweep" };
  }

  if (
    direction === "SELL" &&
    last.low < priorLow &&
    last.close > priorLow
  ) {
    return { passed: false, reason: "Possible sell-side liquidity sweep" };
  }

  return { passed: true };
}

function buildTrade(candles, direction) {
  const atr = calculateATR(candles, 14);

  if (!atr || atr <= 0) return null;

  const last = candles[candles.length - 1];
  const entry = last.close;

  const slDistance = atr * CONFIG.atrMultiplierSL;

  const stopLoss = direction === "BUY"
    ? entry - slDistance
    : entry + slDistance;

  const target = direction === "BUY"
    ? entry + slDistance * CONFIG.riskReward
    : entry - slDistance * CONFIG.riskReward;

  return {
    entry: Number(entry.toFixed(8)),
    stopLoss: Number(stopLoss.toFixed(8)),
    target: Number(target.toFixed(8)),
    riskReward: CONFIG.riskReward
  };
}

async function analyzeCoin(pair) {
  try {
    const [c5, c15, c1h, book] = await Promise.all([
      getCandles(pair, "5m"),
      getCandles(pair, "15m"),
      getCandles(pair, "1h"),
      getOrderbook(pair)
    ]);

    if (
      c5.length < 50 ||
      c15.length < 55 ||
      c1h.length < 55
    ) {
      return null;
    }

    const price = c5[c5.length - 1].close;

    const volumeSignal = detectVolumeExpansion(c5);
    if (!volumeSignal) return null;

    const trend15 = analyzeTrend(c15);
    const trend1h = analyzeTrend(c1h);

    let direction;

    if (
      trend15 === "BULLISH" &&
      trend1h === "BULLISH"
    ) {
      direction = "BUY";
    } else if (
      trend15 === "BEARISH" &&
      trend1h === "BEARISH"
    ) {
      direction = "SELL";
    } else {
      return null;
    }

    const liquidity = checkOrderbook(book, price);
    if (!liquidity.passed) return null;

    const trap = checkLiquidityTrap(c5, direction);
    if (!trap.passed) return null;

    const trade = buildTrade(c5, direction);
    if (!trade) return null;

    const currentCandle = c5[c5.length - 1];

    const quoteVolume =
      currentCandle.close * currentCandle.volume;

    if (quoteVolume < CONFIG.minimumQuoteVolume) {
      return null;
    }

    return {
      coin: getBaseSymbol(pair),
      pair,
      direction,
      timeframe: "5m",
      trend15m: trend15,
      trend1h: trend1h,
      volumeMA: Number(volumeSignal.volumeMA.toFixed(4)),
      volumeMARisePercent:
        Number((volumeSignal.risePercent * 100).toFixed(2)),
      volumeRatio:
        Number(volumeSignal.volumeRatio.toFixed(2)),
      spreadPercent:
        Number((liquidity.spread * 100).toFixed(3)),
      liquidityStatus: "PASSED",
      trapProtection: "PASSED",
      ...trade,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    scanStatus.errors++;
    return null;
  }
}

async function scanMarket() {
  if (scanning) return;

  scanning = true;
  scanStatus.running = true;
  scanStatus.message = "Scanning CoinDCX market";

  let scanned = 0;
  const found = [];

  try {
    const activePairs = await getPairs();

    const pairs = selectedScanLimit === "ALL"
      ? activePairs
      : activePairs.slice(0, Number(selectedScanLimit));

    scanStatus.activePairs = activePairs.length;
    scanStatus.totalPairs = pairs.length;
    scanStatus.scanned = 0;
    scanStatus.errors = 0;

    for (
      let i = 0;
      i < pairs.length;
      i += CONFIG.concurrency
    ) {
      const batch = pairs.slice(i, i + CONFIG.concurrency);

      const results = await Promise.all(
        batch.map(pair => analyzeCoin(pair))
      );

      scanned += batch.length;

      for (const result of results) {
        if (result) found.push(result);
      }

      scanStatus.scanned = scanned;

      await sleep(300);
    }

    signals = found
      .sort((a, b) =>
        b.volumeMARisePercent - a.volumeMARisePercent
      )
      .slice(0, CONFIG.maxSignals);

    scanStatus.lastScan = new Date().toISOString();

    scanStatus.message = signals.length
      ? `${signals.length} confirmed signals found`
      : "NO TRADE - No setup passed all strict filters";

  } catch (error) {
    scanStatus.errors++;
    scanStatus.message = error.message;
  } finally {
    scanning = false;
    scanStatus.running = false;
  }
}

app.get("/api/settings", (req, res) => {
  res.json({
    selectedScanLimit,
    options: [
      { value: 100, label: "100 Coins" },
      { value: 200, label: "200 Coins" },
      { value: 500, label: "500 Coins" },
      { value: 1000, label: "1000 Coins" },
      { value: "ALL", label: "All Active Coins" }
    ]
  });
});

app.post("/api/settings", (req, res) => {
  const value = req.body.scanLimit;
  const normalized = value === "ALL" ? "ALL" : Number(value);

  if (!LIMIT_OPTIONS.includes(normalized)) {
    return res.status(400).json({
      success: false,
      message: "Invalid scan limit"
    });
  }

  selectedScanLimit = normalized;

  res.json({
    success: true,
    selectedScanLimit,
    message: "Scan limit updated"
  });

  if (!scanning) {
    scanMarket();
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    ...scanStatus,
    selectedScanLimit,
    scanOptions: LIMIT_OPTIONS
  });
});

app.get("/api/signals", (req, res) => {
  res.json({
    status: signals.length ? "SIGNALS_FOUND" : "NO_TRADE",
    count: signals.length,
    signals
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    online: true,
    scanner: "Volume Momentum Scanner",
    exchange: "CoinDCX",
    timeframe: "5m",
    confirmation: ["15m", "1h"],
    timestamp: new Date().toISOString()
  });
});

app.get("/api/refresh", async (req, res) => {
  if (scanning) {
    return res.json({
      success: false,
      message: "Scan already running"
    });
  }

  scanMarket();

  res.json({
    success: true,
    message: "New scan started"
  });
});

app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

app.listen(PORT, () => {
  console.log(`Scanner running on port ${PORT}`);
  scanMarket();

  setInterval(() => {
    scanMarket();
  }, CONFIG.scanInterval);
});
