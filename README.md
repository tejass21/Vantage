# Vantage Markets USD/JPY Quantitative Sniper Engine (v8.0 PRO)

Independent, institutional-grade automated tick collector, quantitative sniper predictor, and browser HUD system configured exclusively for **Vantage Markets**.

---

## 📁 Project Architecture

| File | Purpose |
| :--- | :--- |
| **`config.json`** | Contains authenticated credentials, tokens (`auth_token`, `trade_token`), Account ID (`26220746`), User ID (`12179632`), and endpoints. |
| **`collector.py`** | Cloud/Local tick collector that streams live USD/JPY ticks from Vantage WebSocket and logs to `Data/USDJPY_ticks.csv`. |
| **`predictor.py`** | Quantitative Confluence & Sniper Rejection Engine (RSI 14, Bollinger Bands, EMA 9/21/50, S/R Bounce, Pinbar wick rejections). |
| **`api_client.py`** | REST & Trading API client for Vantage (Account details, quotes, balance, and order placement). |
| **`vantage_predictor.js`** | Tampermonkey UserScript that injects a Cyberpunk HUD directly on Vantage WebTrader with live sniper signals & sound alerts. |
| **`requirements.txt`** | Python dependencies required to run the engine. |

---

## 🚀 Quick Start Guide

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Run Real-time Sniper Predictor
To monitor live market prices, auto-save ticks, and calculate sniper signals:
```bash
python predictor.py --mode sniper
```

Other available strategy modes:
- `--mode adaptive` : Switches between trend momentum and range mean-reversion.
- `--mode inverse` : Detects broker liquidity sweeps & stop-hunt traps.

### 3. Run Tick Collector
To collect ticks in the background for backtesting or dataset building:
```bash
python collector.py --duration 14400
```
Ticks are saved automatically into `Data/USDJPY_ticks.csv`.

---

## 🖥️ Browser HUD Setup (Tampermonkey)

1. Install the **Tampermonkey** extension in your browser (Chrome/Brave/Edge).
2. Open Tampermonkey Dashboard ➔ **Add a new script (+)**.
3. Open `vantage_predictor.js`, copy all contents, paste it into Tampermonkey, and click **Save** (`Ctrl + S`).
4. Navigate to [Vantage Secure Portal](https://secure.vantagemarkets.com/home) or Vantage WebTrader.
5. You will see the **Vantage USD/JPY Sniper HUD** floating at the bottom right corner with:
   - Live tick price & real-time RSI calculation.
   - Sniper BUY/SELL signals with confidence percentage.
   - 60-second candle countdown bar.
   - Automatic audio chime when high-confidence setups trigger.

---

## 🔑 Updating Tokens When Session Expires
Jab bhi Vantage ka token expire ho, browser console me run karke naya `auth_token` aur `cookies` [config.json](file:///c:/Users/Satish/Desktop/D/USD/Vantage/config.json) me paste kar dijiye.
