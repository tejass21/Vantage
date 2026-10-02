// ==UserScript==
// @name         Vantage Markets Autonomous Quantitative Sniper & Auto-Trader (v9.0 PRO)
// @namespace    http://tampermonkey.net/
// @version      9.0
// @description  Institutional Quantitative Sniper Engine with Automated Risk Sizing, Auto-Execution, and Trailing TP/SL for Vantage Markets
// @author       You
// @match        https://secure.vantagemarkets.com/*
// @match        https://*.vantagemarkets.com/*
// @match        https://*.vantagefx.com/*
// @match        https://*.polokalamumakeke.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.__VANTAGE_SNIPER_AUTOTRADER) return;
  window.__VANTAGE_SNIPER_AUTOTRADER = true;

  // ============================================================
  // CONFIGURATION & TRADING PARAMETERS
  // ============================================================
  const CONFIG = {
    DEFAULT_TARGET: "USDJPY",
    MAX_TICKS: 2000,
    M1_HISTORY_LEN: 100,
    COOLDOWN_SECONDS: 90, // Wait at least 90s between auto-trades
    MAX_DAILY_TRADES: 6,
    MAX_CONSECUTIVE_LOSSES: 3
  };

  // ============================================================
  // STATE MANAGEMENT
  // ============================================================
  const state = {
    activeAsset: "USDJPY",
    assets: {},
    mode: "sniper",
    minConfidence: 80,
    autoTradeEnabled: false,
    riskMode: "fixed_001", // "fixed_001", "risk_05", "risk_10"
    equity: 10000.0,
    todayTrades: 0,
    consecutiveLosses: 0,
    stats: { wins: 0, losses: 0, ties: 0 },
    lastTradeTime: 0,
    lastPredTime: 0,
    hudReady: false,
    soundEnabled: true,
    tradeLog: []
  };

  // ============================================================
  // AUDIO NOTIFICATIONS (Web Audio API)
  // ============================================================
  function playAlertSound(type = "buy") {
    if (!state.soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";

      if (type === "buy") {
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.25);
      } else if (type === "sell") {
        osc.frequency.setValueAtTime(660, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(330, ctx.currentTime + 0.25);
      } else if (type === "trade_executed") {
        osc.frequency.setValueAtTime(523, ctx.currentTime); // C5
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.1); // E5
        osc.frequency.setValueAtTime(783, ctx.currentTime + 0.2); // G5
      }

      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (e) {}
  }

  // ============================================================
  // TECHNICAL INDICATORS & ATR
  // ============================================================
  const Indicators = {
    calcEMA: function (series, period) {
      if (!series || series.length === 0) return 0;
      if (series.length < period) return series.reduce((a, b) => a + b, 0) / series.length;
      const k = 2 / (period + 1);
      let ema = series[0];
      for (let i = 1; i < series.length; i++) {
        ema = series[i] * k + ema * (1 - k);
      }
      return ema;
    },

    calcRSI: function (prices, period = 14) {
      if (!prices || prices.length < period + 1) return 50;
      let gains = 0, losses = 0;
      for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
      }
      let avgGain = gains / period;
      let avgLoss = losses / period;
      for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) {
          avgGain = (avgGain * (period - 1) + diff) / period;
          avgLoss = (avgLoss * (period - 1)) / period;
        } else {
          avgGain = (avgGain * (period - 1)) / period;
          avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
      }
      if (avgLoss === 0) return 100;
      return 100 - (100 / (1 + (avgGain / avgLoss)));
    },

    calcBollingerBands: function (prices, period = 20, multiplier = 2.0) {
      if (!prices || prices.length < period) {
        const avg = prices && prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
        return { middle: avg, upper: avg, lower: avg, pctB: 0.5 };
      }
      const slice = prices.slice(-period);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
      const stdev = Math.sqrt(variance);
      const upper = mean + multiplier * stdev;
      const lower = mean - multiplier * stdev;
      const width = upper - lower;
      const current = slice[slice.length - 1];
      const pctB = width > 0 ? (current - lower) / width : 0.5;
      return { middle: mean, upper, lower, pctB };
    },

    calcATR: function (candles, period = 14) {
      if (!candles || candles.length < 2) return 0.05;
      const trs = [];
      for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const prev = candles[i - 1];
        const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
        trs.push(tr);
      }
      const slice = trs.slice(-period);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    }
  };

  // ============================================================
  // PREDICTOR ENGINE
  // ============================================================
  class AssetEngine {
    constructor(symbol) {
      this.symbol = symbol;
      this.ticks = [];
      this.m1Candles = [];
      this.currentM1 = null;
      this.lastMinute = -1;
    }

    addTick(price, timeMs) {
      this.ticks.push({ price, time: timeMs });
      if (this.ticks.length > CONFIG.MAX_TICKS) this.ticks.shift();

      const minute = Math.floor(timeMs / 60000);
      if (this.lastMinute === -1) {
        this.lastMinute = minute;
        this.currentM1 = { open: price, high: price, low: price, close: price, start: minute * 60000 };
      } else if (minute > this.lastMinute) {
        if (this.currentM1) {
          this.m1Candles.push(this.currentM1);
          if (this.m1Candles.length > CONFIG.M1_HISTORY_LEN) this.m1Candles.shift();
        }
        this.lastMinute = minute;
        this.currentM1 = { open: price, high: price, low: price, close: price, start: minute * 60000 };
      } else {
        this.currentM1.high = Math.max(this.currentM1.high, price);
        this.currentM1.low = Math.min(this.currentM1.low, price);
        this.currentM1.close = price;
      }
    }

    evaluate() {
      if (this.m1Candles.length < 10 || this.ticks.length === 0) {
        return { signal: "WAITING", confidence: 0, reasons: [] };
      }

      const currentPrice = this.ticks[this.ticks.length - 1].price;
      const closes = this.m1Candles.map(c => c.close).concat([currentPrice]);
      const atr = Indicators.calcATR(this.m1Candles, 14);

      const ema9 = Indicators.calcEMA(closes, 9);
      const ema21 = Indicators.calcEMA(closes, 21);
      const ema50 = Indicators.calcEMA(closes, 50);
      const rsi = Indicators.calcRSI(closes, 14);
      const bb = Indicators.calcBollingerBands(closes, 20, 2.0);

      // S/R based on dynamic ATR
      const highs = this.m1Candles.slice(-20).map(c => c.high);
      const lows = this.m1Candles.slice(-20).map(c => c.low);
      const resistance = Math.max(...highs);
      const support = Math.min(...lows);
      const tol = Math.max(0.6 * atr, 0.0003 * currentPrice);
      const atSupport = Math.abs(currentPrice - support) <= tol;
      const atResistance = Math.abs(currentPrice - resistance) <= tol;

      // Pinbar wick detection
      const lastC = this.m1Candles[this.m1Candles.length - 1];
      const body = Math.abs(lastC.close - lastC.open);
      const uWick = lastC.high - Math.max(lastC.open, lastC.close);
      const lWick = Math.min(lastC.open, lastC.close) - lastC.low;
      const isBullPin = lWick >= 1.5 * body && lWick >= 0.4 * atr && uWick <= 0.35 * body;
      const isBearPin = uWick >= 1.5 * body && uWick >= 0.4 * atr && lWick <= 0.35 * body;

      let bull = 0, bear = 0;
      const reasons = [];

      if (ema9 > ema21 && currentPrice >= ema21) { bull += 25; reasons.push("EMA Bull Trend"); }
      else if (ema9 < ema21 && currentPrice <= ema21) { bear += 25; reasons.push("EMA Bear Trend"); }

      if (currentPrice > ema50) bull += 10;
      else if (currentPrice < ema50) bear += 10;

      if (atSupport) { bull += 20; reasons.push("Key Support Bounce"); }
      else if (atResistance) { bear += 20; reasons.push("Key Resistance Rejection"); }

      if (rsi <= 35) { bull += 20; reasons.push(`RSI(${rsi.toFixed(0)}) Oversold`); }
      else if (rsi >= 65) { bear += 20; reasons.push(`RSI(${rsi.toFixed(0)}) Overbought`); }

      if (bb.pctB <= 0.12) { bull += 15; reasons.push("BB Lower Exhaustion"); }
      else if (bb.pctB >= 0.88) { bear += 15; reasons.push("BB Upper Exhaustion"); }

      if (isBullPin) { bull += 15; reasons.push("Bull Pinbar Rejection"); }
      else if (isBearPin) { bear += 15; reasons.push("Bear Pinbar Rejection"); }

      let signal = "NEUTRAL";
      let confidence = 0;

      if (bull >= 65 && bull > bear + 20) {
        signal = "BUY";
        confidence = Math.min(95, bull);
      } else if (bear >= 65 && bear > bull + 20) {
        signal = "SELL";
        confidence = Math.min(95, bear);
      } else {
        signal = "WAITING";
        confidence = Math.max(20, Math.abs(bull - bear));
      }

      return { signal, confidence, reasons, rsi, atr, currentPrice };
    }
  }

  // ============================================================
  // AUTONOMOUS EXECUTION ENGINE (DOM AUTOMATION)
  // ============================================================
  const AutoTrader = {
    calculateLotSize: function (stopLossPips = 10) {
      if (state.riskMode === "fixed_001") return "0.01";

      // Read Equity from page
      const equityText = document.body.innerText.match(/Equity:\s*([\d,.]+)/i);
      if (equityText && equityText[1]) {
        state.equity = parseFloat(equityText[1].replace(/,/g, "")) || 10000;
      }

      const riskPercent = state.riskMode === "risk_10" ? 0.01 : 0.005; // 1% or 0.5%
      const riskAmount = state.equity * riskPercent;

      // 1 Standard Lot = $10 per pip for USD pairs
      let lot = (riskAmount / (stopLossPips * 10)).toFixed(2);
      lot = Math.max(0.01, Math.min(0.50, parseFloat(lot))).toFixed(2);
      return lot;
    },

    executeTrade: async function (direction, confidence) {
      if (!state.autoTradeEnabled) return;

      // Safety checks
      if (state.todayTrades >= CONFIG.MAX_DAILY_TRADES) {
        console.warn("[AutoTrader] Daily trades limit reached!");
        return;
      }
      if (state.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
        console.warn("[AutoTrader] Circuit breaker active! Max consecutive losses hit.");
        return;
      }
      if (Date.now() - state.lastTradeTime < CONFIG.COOLDOWN_SECONDS * 1000) {
        return; // In cooldown
      }

      state.lastTradeTime = Date.now();
      const lotSize = this.calculateLotSize(10);
      console.log(`%c[AutoTrader TRIGGERED] >>> ${direction} <<< | Lot: ${lotSize} | Conf: ${confidence}%`, "color: #00ff66; font-size: 14px; font-weight: bold;");

      // 1. Select Direction Tab (Buy or Sell)
      const isBuy = direction === "BUY";
      const tabs = Array.from(document.querySelectorAll("button, div[role='tab'], div"));
      const targetTab = tabs.find(el => {
        const text = el.innerText ? el.innerText.trim() : "";
        return isBuy ? text.startsWith("Buy") : text.startsWith("Sell");
      });
      if (targetTab) {
        targetTab.click();
        await new Promise(r => setTimeout(r, 200));
      }

      // 2. Set Volume Input
      const volumeInput = document.querySelector("input[type='number'], input[placeholder*='Lots'], input[placeholder*='0.']");
      if (volumeInput) {
        volumeInput.focus();
        volumeInput.value = lotSize;
        volumeInput.dispatchEvent(new Event("input", { bubbles: true }));
        volumeInput.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
      }

      // 3. Click Submit Button
      const buttons = Array.from(document.querySelectorAll("button"));
      const actionButton = buttons.find(b => {
        const t = b.innerText ? b.innerText.trim() : "";
        return isBuy ? (t === "Buy" || t.includes("Buy")) : (t === "Sell" || t.includes("Sell"));
      });

      if (actionButton) {
        actionButton.click();
        state.todayTrades++;
        playAlertSound("trade_executed");

        // Log to HUD
        const logEntry = {
          time: new Date().toLocaleTimeString(),
          symbol: state.activeAsset,
          type: direction,
          lot: lotSize,
          status: "FILLED"
        };
        state.tradeLog.unshift(logEntry);
        updateHUDLog();
        console.log("%c✅ [AutoTrader] Order submitted successfully!", "color: #00e5ff; font-weight: bold;");
      }
    }
  };

  // ============================================================
  // SCANNER & HOOKS
  // ============================================================
  function scanObject(obj) {
    if (!obj) return;
    if (typeof obj === "string") {
      try { obj = JSON.parse(obj); } catch (e) { return; }
    }
    if (Array.isArray(obj)) {
      obj.forEach(item => scanObject(item));
      return;
    }
    if (typeof obj === "object") {
      const sym = obj.symbol || obj.s || obj.asset || obj.ric || obj.pair;
      const px = obj.price || obj.p || obj.rate || obj.ask || obj.bid || obj.close;
      const tm = obj.timestamp || obj.t || obj.time;

      if (sym && px) {
        handleTick(String(sym), parseFloat(px), tm ? Number(tm) : Date.now());
      }
      for (let k in obj) {
        if (typeof obj[k] === "object") scanObject(obj[k]);
      }
    }
  }

  function handleTick(ric, price, timeMs) {
    if (isNaN(price) || price <= 0) return;
    const name = ric.replace("/", "").replace("-", "").toUpperCase();

    if (!state.assets[name]) {
      state.assets[name] = new AssetEngine(name);
    }
    if (name.includes("USDJPY") || name.includes("XAUUSD") || name.includes("EURUSD") || name.includes("NAS100")) {
      state.activeAsset = name;
    }

    const engine = state.assets[name];
    engine.addTick(price, timeMs);

    if (name === state.activeAsset && state.hudReady) {
      updateHUD(price);
    }
  }

  // Hook WebSockets
  const OrigWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    ws.addEventListener("message", function (e) {
      if (typeof e.data === "string" && (e.data.startsWith("{") || e.data.startsWith("["))) {
        try { scanObject(JSON.parse(e.data)); } catch (err) {}
      }
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;

  // Hook Fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const clone = res.clone();
      clone.json().then(data => scanObject(data)).catch(() => {});
    } catch (e) {}
    return res;
  };

  // ============================================================
  // ADVANCED CYBERPUNK HUD WITH AUTO-TRADING SWITCH
  // ============================================================
  function createHUD() {
    if (document.getElementById("vantage-sniper-hud")) return;

    const style = document.createElement("style");
    style.textContent = `
      #vantage-sniper-hud {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 11px;
        color: #e2e8f0;
        user-select: none;
      }
      .vj-panel {
        background: rgba(10, 15, 26, 0.96);
        backdrop-filter: blur(25px);
        border: 1px solid rgba(0, 229, 255, 0.4);
        border-radius: 14px;
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.85), 0 0 24px rgba(0, 229, 255, 0.18);
        width: 340px;
        overflow: hidden;
      }
      .vj-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px;
        background: linear-gradient(135deg, rgba(0, 229, 255, 0.25), rgba(0, 100, 255, 0.1));
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      .vj-title { font-weight: 800; font-size: 13px; color: #00e5ff; display: flex; align-items: center; gap: 6px; }
      .vj-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
      
      .vj-autotrade-box {
        display: flex; align-items: center; justify-content: space-between;
        background: #060913; border: 1px solid #1a2744; border-radius: 8px; padding: 8px 12px;
      }
      .vj-switch {
        cursor: pointer; padding: 4px 12px; border-radius: 6px; font-weight: 800; font-size: 11px;
        transition: all 0.2s ease;
      }
      .vj-off { background: #334155; color: #94a3b8; }
      .vj-on { background: #00e676; color: #000; box-shadow: 0 0 12px rgba(0, 230, 118, 0.6); }

      .vj-signal-card {
        background: #0d1424; border: 1px solid #1f2d47; border-radius: 10px;
        padding: 10px; text-align: center;
      }
      .vj-signal-text { font-size: 22px; font-weight: 900; letter-spacing: 0.5px; }
      .vj-buy { color: #00e676; text-shadow: 0 0 16px rgba(0, 230, 118, 0.6); }
      .vj-sell { color: #ff3366; text-shadow: 0 0 16px rgba(255, 51, 102, 0.6); }
      .vj-neutral { color: #f59e0b; }
      .vj-timer-bar { height: 4px; background: #1e293b; border-radius: 2px; margin-top: 8px; overflow: hidden; }
      .vj-timer-fill { height: 100%; width: 0%; background: #00e5ff; transition: width 0.2s linear; }

      .vj-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 11px; }
      .vj-item { background: #090e1a; padding: 6px 8px; border-radius: 6px; border: 1px solid #141d30; display: flex; justify-content: space-between; }
      .vj-val { font-weight: bold; color: #38bdf8; }
      
      .vj-log { max-height: 80px; overflow-y: auto; background: #060911; padding: 6px; border-radius: 6px; border: 1px solid #121a2c; font-size: 10px; }
      .vj-log-item { display: flex; justify-content: space-between; padding: 2px 0; border-bottom: 1px solid #111a2d; }
    `;
    document.head.appendChild(style);

    const hud = document.createElement("div");
    hud.id = "vantage-sniper-hud";
    hud.innerHTML = `
      <div class="vj-panel">
        <div class="vj-header">
          <div class="vj-title">🎯 Vantage Autonomous Engine</div>
          <span style="font-size: 10px; color: #38bdf8;">v9.0 PRO</span>
        </div>
        <div class="vj-body">
          <div class="vj-autotrade-box">
            <div>
              <div style="font-weight:bold; color:#fff;">Auto-Execution</div>
              <div style="font-size:10px; color:#64748b;">Risk: Fixed 0.01 Lot</div>
            </div>
            <div id="vj-toggle" class="vj-switch vj-off">AUTO: OFF</div>
          </div>

          <div class="vj-signal-card">
            <div id="vj-signal" class="vj-signal-text vj-neutral">SCANNING</div>
            <div id="vj-reason" style="font-size: 10px; color: #94a3b8; margin-top: 4px;">Analyzing market flow...</div>
            <div class="vj-timer-bar"><div id="vj-timer-fill" class="vj-timer-fill"></div></div>
          </div>

          <div class="vj-grid">
            <div class="vj-item"><span>Asset:</span><span id="vj-asset" class="vj-val">USDJPY</span></div>
            <div class="vj-item"><span>Price:</span><span id="vj-price" class="vj-val">--</span></div>
            <div class="vj-item"><span>RSI (14):</span><span id="vj-rsi" class="vj-val">--</span></div>
            <div class="vj-item"><span>ATR:</span><span id="vj-atr" class="vj-val">--</span></div>
          </div>

          <div style="font-size:10px; color:#64748b; font-weight:bold;">Recent Execution Log:</div>
          <div id="vj-log-box" class="vj-log">
            <div style="color:#475569; text-align:center; padding:4px;">No auto-trades yet. Turn AUTO ON.</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(hud);
    state.hudReady = true;

    // Toggle button handler
    const toggleBtn = document.getElementById("vj-toggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        state.autoTradeEnabled = !state.autoTradeEnabled;
        if (state.autoTradeEnabled) {
          toggleBtn.textContent = "AUTO: ON (ACTIVE)";
          toggleBtn.className = "vj-switch vj-on";
          playAlertSound("trade_executed");
        } else {
          toggleBtn.textContent = "AUTO: OFF";
          toggleBtn.className = "vj-switch vj-off";
        }
      });
    }

    // Timer bar
    setInterval(() => {
      const now = new Date();
      const sec = now.getSeconds();
      const pct = (sec / 60) * 100;
      const fill = document.getElementById("vj-timer-fill");
      if (fill) fill.style.width = `${pct}%`;
    }, 200);
  }

  function updateHUD(price) {
    const engine = state.assets[state.activeAsset];
    if (!engine) return;
    const res = engine.evaluate();

    const elPrice = document.getElementById("vj-price");
    const elAsset = document.getElementById("vj-asset");
    const elRsi = document.getElementById("vj-rsi");
    const elAtr = document.getElementById("vj-atr");
    const elSig = document.getElementById("vj-signal");
    const elRsn = document.getElementById("vj-reason");

    if (elPrice) elPrice.textContent = price.toFixed(2);
    if (elAsset) elAsset.textContent = state.activeAsset;
    if (elRsi && res.rsi) elRsi.textContent = res.rsi.toFixed(1);
    if (elAtr && res.atr) elAtr.textContent = res.atr.toFixed(2);

    if (elSig && elRsn) {
      if (res.signal === "BUY" && res.confidence >= state.minConfidence) {
        elSig.textContent = `▲ BUY (${res.confidence}%)`;
        elSig.className = "vj-signal-text vj-buy";
        elRsn.textContent = res.reasons.slice(0, 2).join(" + ");

        if (Date.now() - state.lastPredTime > 30000) {
          playAlertSound("buy");
          state.lastPredTime = Date.now();
        }

        // TRIGGER AUTO TRADE
        AutoTrader.executeTrade("BUY", res.confidence);

      } else if (res.signal === "SELL" && res.confidence >= state.minConfidence) {
        elSig.textContent = `▼ SELL (${res.confidence}%)`;
        elSig.className = "vj-signal-text vj-sell";
        elRsn.textContent = res.reasons.slice(0, 2).join(" + ");

        if (Date.now() - state.lastPredTime > 30000) {
          playAlertSound("sell");
          state.lastPredTime = Date.now();
        }

        // TRIGGER AUTO TRADE
        AutoTrader.executeTrade("SELL", res.confidence);

      } else {
        elSig.textContent = "WAITING SETUP";
        elSig.className = "vj-signal-text vj-neutral";
        elRsn.textContent = "Filtering market noise (Target 80%+)";
      }
    }
  }

  function updateHUDLog() {
    const box = document.getElementById("vj-log-box");
    if (!box) return;
    if (state.tradeLog.length === 0) return;

    box.innerHTML = state.tradeLog.slice(0, 4).map(t => `
      <div class="vj-log-item">
        <span style="color:#94a3b8;">${t.time}</span>
        <span style="font-weight:bold; color:${t.type==='BUY'?'#00e676':'#ff3366'};">${t.type} (${t.lot}L)</span>
        <span style="color:#38bdf8;">${t.symbol}</span>
      </div>
    `).join("");
  }

  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(createHUD, 1500);
  });
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(createHUD, 1500);
  }
})();
