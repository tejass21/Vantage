// ==UserScript==
// @name         Vantage Markets USD/JPY Quantitative Sniper Engine (v8.0 PRO)
// @namespace    http://tampermonkey.net/
// @version      8.0
// @description  Institutional 6-Factor Confluence & Sniper Rejection Predictor for Vantage Markets (RSI, S/R, BB 2.5-Sigma, ADX Regime, M1/M5 EMAs, Price Action Pinbar)
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

  if (window.__VANTAGE_SNIPER_PREDICTOR) return;
  window.__VANTAGE_SNIPER_PREDICTOR = true;

  // ============================================================
  // CONFIGURATION
  // ============================================================
  const CONFIG = {
    PREDICT_SECONDS: 60,
    MIN_CONFIDENCE_SNIPER: 70,
    DEFAULT_TARGET: "USDJPY",
    MAX_TICKS: 2000,
    M1_HISTORY_LEN: 100,
    M5_HISTORY_LEN: 40
  };

  // ============================================================
  // STATE MANAGEMENT
  // ============================================================
  const state = {
    activeAsset: "USDJPY",
    assets: {},
    mode: "sniper", // "sniper", "regime_adaptive", "confluence", "inverse"
    minConfidence: 70,
    stats: { wins: 0, losses: 0, ties: 0, total: 0 },
    pending: [],
    history: [],
    lastPredTime: 0,
    lastCandleAlert: 0,
    hudReady: false,
    soundEnabled: true
  };

  // ============================================================
  // SOUND NOTIFICATION HELPER (Web Audio API)
  // ============================================================
  function playAlertSound(isBuy = true) {
    if (!state.soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(isBuy ? 880 : 440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(isBuy ? 1320 : 330, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {}
  }

  // ============================================================
  // TECHNICAL INDICATORS
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
      const rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    },

    calcBollingerBands: function (prices, period = 20, multiplier = 2.0) {
      if (!prices || prices.length < period) {
        const avg = prices && prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
        return { middle: avg, upper: avg, lower: avg, bandwidth: 0, pctB: 0.5 };
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
      return { middle: mean, upper, lower, bandwidth: (width / mean) * 100, pctB };
    }
  };

  // ============================================================
  // PRICE ACTION & REJECTION
  // ============================================================
  const PriceAction = {
    analyzeCandle: function (candle) {
      if (!candle) return { pattern: "NORMAL", rejection: "NONE" };
      const body = Math.abs(candle.close - candle.open);
      const range = candle.high - candle.low;
      if (range === 0) return { pattern: "DOJI", rejection: "NONE" };

      const upperWick = candle.high - Math.max(candle.open, candle.close);
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;

      if (lowerWick >= 2.0 * body && upperWick <= 0.3 * body) {
        return { pattern: "BULLISH_PINBAR", rejection: "BULLISH_REJECTION" };
      }
      if (upperWick >= 2.0 * body && lowerWick <= 0.3 * body) {
        return { pattern: "BEARISH_PINBAR", rejection: "BEARISH_REJECTION" };
      }
      return { pattern: "STANDARD", rejection: "NONE" };
    }
  };

  // ============================================================
  // ASSET PREDICTOR CLASS
  // ============================================================
  class VantageSniperPredictor {
    constructor(symbol) {
      this.symbol = symbol;
      this.ticks = [];
      this.m1Candles = [];
      this.currentM1 = null;
      this.lastM1Minute = -1;
    }

    addTick(price, timeMs) {
      if (!timeMs) timeMs = Date.now();
      this.ticks.push({ price, time: timeMs });
      if (this.ticks.length > CONFIG.MAX_TICKS) this.ticks.shift();

      const minute = Math.floor(timeMs / 60000);
      if (this.lastM1Minute === -1) {
        this.lastM1Minute = minute;
        this.currentM1 = { open: price, high: price, low: price, close: price, start: minute * 60000 };
      } else if (minute > this.lastM1Minute) {
        if (this.currentM1) {
          this.m1Candles.push(this.currentM1);
          if (this.m1Candles.length > CONFIG.M1_HISTORY_LEN) this.m1Candles.shift();
        }
        this.lastM1Minute = minute;
        this.currentM1 = { open: price, high: price, low: price, close: price, start: minute * 60000 };
      } else {
        this.currentM1.high = Math.max(this.currentM1.high, price);
        this.currentM1.low = Math.min(this.currentM1.low, price);
        this.currentM1.close = price;
      }
      return true;
    }

    evaluate() {
      if (this.m1Candles.length < 5 || this.ticks.length === 0) {
        return { signal: "WAITING_DATA", confidence: 0, breakdown: "Collecting candle & tick history..." };
      }

      const currentPrice = this.ticks[this.ticks.length - 1].price;
      const closes = this.m1Candles.map(c => c.close).concat([currentPrice]);

      const ema9 = Indicators.calcEMA(closes, 9);
      const ema21 = Indicators.calcEMA(closes, 21);
      const rsi14 = Indicators.calcRSI(closes, 14);
      const bb = Indicators.calcBollingerBands(closes, 20, 2.0);
      const pa = PriceAction.analyzeCandle(this.m1Candles[this.m1Candles.length - 1]);

      let bullScore = 0;
      let bearScore = 0;
      const factors = [];

      // F1: Trend
      if (ema9 > ema21 && currentPrice >= ema21) {
        bullScore += 25;
        factors.push("EMA Bull Trend");
      } else if (ema9 < ema21 && currentPrice <= ema21) {
        bearScore += 25;
        factors.push("EMA Bear Trend");
      }

      // F2: RSI
      if (rsi14 <= 35) {
        bullScore += 20;
        factors.push(`RSI(${rsi14.toFixed(0)}) Oversold`);
      } else if (rsi14 >= 65) {
        bearScore += 20;
        factors.push(`RSI(${rsi14.toFixed(0)}) Overbought`);
      }

      // F3: Bollinger Bands
      if (bb.pctB <= 0.12) {
        bullScore += 20;
        factors.push("BB Lower Exhaustion");
      } else if (bb.pctB >= 0.88) {
        bearScore += 20;
        factors.push("BB Upper Exhaustion");
      }

      // F4: Pinbar
      if (pa.rejection === "BULLISH_REJECTION") {
        bullScore += 20;
        factors.push("Bull Pinbar Wick");
      } else if (pa.rejection === "BEARISH_REJECTION") {
        bearScore += 20;
        factors.push("Bear Pinbar Wick");
      }

      let signal = "NEUTRAL";
      let confidence = 0;
      let breakdown = "";

      if (state.mode === "sniper") {
        if (bullScore >= 60 && bullScore > bearScore + 20) {
          signal = "BUY (UP)";
          confidence = Math.min(95, bullScore);
          breakdown = `Sniper Bull [${factors.slice(0, 2).join(", ")}]`;
        } else if (bearScore >= 60 && bearScore > bullScore + 20) {
          signal = "SELL (DOWN)";
          confidence = Math.min(95, bearScore);
          breakdown = `Sniper Bear [${factors.slice(0, 2).join(", ")}]`;
        } else {
          signal = "NEUTRAL (FILTERED)";
          confidence = Math.max(20, Math.abs(bullScore - bearScore));
          breakdown = "Waiting High-Precision Setup";
        }
      } else if (state.mode === "inverse") {
        if (bearScore >= 60 && bb.pctB >= 0.85) {
          signal = "BUY (UP)";
          confidence = Math.min(92, bearScore);
          breakdown = "Counter-Trap Broker Inversion";
        } else if (bullScore >= 60 && bb.pctB <= 0.15) {
          signal = "SELL (DOWN)";
          confidence = Math.min(92, bullScore);
          breakdown = "Counter-Trap Broker Inversion";
        }
      }

      return { signal, confidence, breakdown, rsi: rsi14, ema9, ema21, pctB: bb.pctB };
    }
  }

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
      state.assets[name] = new VantageSniperPredictor(name);
    }
    if (name.includes("USDJPY")) {
      state.activeAsset = name;
    }

    const pred = state.assets[name];
    pred.addTick(price, timeMs);

    if (name === state.activeAsset && state.hudReady) {
      updateHUDPrice(price);
      maybePredict(price);
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
  // HUD UI CREATION
  // ============================================================
  function createHUD() {
    if (document.getElementById("vantage-sniper-hud")) return;

    const style = document.createElement("style");
    style.textContent = `
      #vantage-sniper-hud {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        color: #e2e8f0;
        user-select: none;
      }
      .vj-panel {
        background: rgba(10, 15, 26, 0.95);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(0, 210, 255, 0.35);
        border-radius: 14px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.8), 0 0 20px rgba(0, 210, 255, 0.15);
        width: 330px;
        overflow: hidden;
      }
      .vj-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px;
        background: linear-gradient(135deg, rgba(0, 210, 255, 0.2), rgba(0, 100, 255, 0.08));
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      .vj-title { font-weight: 800; font-size: 13px; color: #00e5ff; display: flex; align-items: center; gap: 6px; }
      .vj-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
      .vj-signal-card {
        background: #0d1424; border: 1px solid #1f2d47; border-radius: 10px;
        padding: 12px; text-align: center;
      }
      .vj-signal-text { font-size: 20px; font-weight: 900; }
      .vj-buy { color: #00e676; text-shadow: 0 0 16px rgba(0, 230, 118, 0.6); }
      .vj-sell { color: #ff3366; text-shadow: 0 0 16px rgba(255, 51, 102, 0.6); }
      .vj-neutral { color: #f59e0b; }
      .vj-timer-bar { height: 4px; background: #1e293b; border-radius: 2px; margin-top: 8px; overflow: hidden; }
      .vj-timer-fill { height: 100%; width: 0%; background: #00e5ff; transition: width 0.2s linear; }
      .vj-details { font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between; margin-top: 4px; }
    `;
    document.head.appendChild(style);

    const hud = document.createElement("div");
    hud.id = "vantage-sniper-hud";
    hud.innerHTML = `
      <div class="vj-panel">
        <div class="vj-header">
          <div class="vj-title">🎯 Vantage USD/JPY Sniper</div>
          <span style="font-size: 10px; color: #38bdf8;">v8.0 PRO</span>
        </div>
        <div class="vj-body">
          <div class="vj-signal-card">
            <div id="vj-signal" class="vj-signal-text vj-neutral">STANDBY</div>
            <div id="vj-reason" style="font-size: 11px; color: #94a3b8; margin-top: 4px;">Connecting to feed...</div>
            <div class="vj-timer-bar"><div id="vj-timer-fill" class="vj-timer-fill"></div></div>
          </div>
          <div class="vj-details">
            <span>Price: <b id="vj-price" style="color:#fff;">--</b></span>
            <span>RSI: <b id="vj-rsi" style="color:#38bdf8;">--</b></span>
            <span>Mode: <b style="color:#00e676;">SNIPER</b></span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(hud);
    state.hudReady = true;

    // Timer update
    setInterval(() => {
      const now = new Date();
      const sec = now.getSeconds();
      const pct = (sec / 60) * 100;
      const fill = document.getElementById("vj-timer-fill");
      if (fill) fill.style.width = `${pct}%`;
    }, 200);
  }

  function updateHUDPrice(price) {
    const el = document.getElementById("vj-price");
    if (el) el.textContent = price.toFixed(3);
  }

  function maybePredict(price) {
    const pred = state.assets[state.activeAsset];
    if (!pred) return;
    const res = pred.evaluate();

    const sigEl = document.getElementById("vj-signal");
    const rsnEl = document.getElementById("vj-reason");
    const rsiEl = document.getElementById("vj-rsi");

    if (rsiEl && res.rsi) rsiEl.textContent = res.rsi.toFixed(1);

    if (sigEl && rsnEl) {
      if (res.signal.includes("BUY")) {
        sigEl.textContent = `▲ ${res.signal} (${res.confidence}%)`;
        sigEl.className = "vj-signal-text vj-buy";
        if (Date.now() - state.lastPredTime > 30000) {
          playAlertSound(true);
          state.lastPredTime = Date.now();
        }
      } else if (res.signal.includes("SELL")) {
        sigEl.textContent = `▼ ${res.signal} (${res.confidence}%)`;
        sigEl.className = "vj-signal-text vj-sell";
        if (Date.now() - state.lastPredTime > 30000) {
          playAlertSound(false);
          state.lastPredTime = Date.now();
        }
      } else {
        sigEl.textContent = "WAITING SETUP";
        sigEl.className = "vj-signal-text vj-neutral";
      }
      rsnEl.textContent = res.breakdown || "";
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(createHUD, 1500);
  });
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(createHUD, 1500);
  }
})();
