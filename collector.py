"""
================================================================================
   VANTAGE MULTI-ASSET CLOUD TICK & CANDLE DATA COLLECTOR (v8.5 PRO)
================================================================================
Continuously fetches real-time market data from Vantage's live institutional
stream API for:
  - USD/JPY (USDJPY)
  - Gold (XAUUSD)
  - Euro / US Dollar (EURUSD)
  - US Tech 100 / Nasdaq (NAS100)
Saves each into dedicated CSV files: Vantage/Data/{SYMBOL}_ticks.csv
Supports 24x7 headless collection and incremental GitHub Actions sync.
================================================================================
"""

import time
import json
import os
import sys
import argparse
import subprocess
from datetime import datetime
import requests

class SymbolTracker:
    def __init__(self, symbol, data_dir):
        self.symbol = symbol
        self.output_file = os.path.join(data_dir, f"{symbol}_ticks.csv")
        self.seen_timestamps = set()
        self.last_price = 0
        self.last_ts = 0
        self.tick_count = 0
        self.buffer = []

        os.makedirs(os.path.dirname(self.output_file), exist_ok=True)
        if not os.path.exists(self.output_file):
            with open(self.output_file, "w", encoding="utf-8") as f:
                f.write("timestamp_ms,price,datetime,volume\n")

        # Preload existing timestamps
        if os.path.exists(self.output_file):
            try:
                with open(self.output_file, "r", encoding="utf-8") as f:
                    for line in f:
                        parts = line.strip().split(",")
                        if parts and parts[0].isdigit():
                            self.seen_timestamps.add(int(parts[0]))
            except Exception:
                pass

    def log_tick(self, price, ts_ms, vol=0):
        if ts_ms in self.seen_timestamps:
            return False
        self.seen_timestamps.add(ts_ms)
        dt_str = datetime.fromtimestamp(ts_ms / 1000.0).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
        self.buffer.append(f"{ts_ms},{price},{dt_str},{vol}\n")
        self.tick_count += 1
        self.flush()
        return True

    def flush(self):
        if not self.buffer:
            return
        with open(self.output_file, "a", encoding="utf-8") as f:
            f.writelines(self.buffer)
        self.buffer.clear()

class VantageMultiAssetCollector:
    def __init__(self, config_path=None, symbols=None):
        if not config_path:
            config_path = os.path.join(os.path.dirname(__file__), "config.json")
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)

        if symbols:
            self.symbols = [s.strip().upper() for s in symbols]
        else:
            self.symbols = self.config.get("target_assets", ["USDJPY", "XAUUSD", "EURUSD", "NAS100"])

        self.kline_url = self.config.get("kline_url", "https://appv2.nv.polokalamumakeke.com:18008/api/kline/query")
        self.account = self.config.get("account_id", "26220746")
        self.source = self.config.get("source", 3012)
        
        self.headers = {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "trade-token": self.config.get("trade_token", ""),
            "X-User-Id": self.config.get("x_user_id", ""),
            "uuid": self.config.get("uuid", ""),
            "product": self.config.get("product", "VAU"),
            "systemType": "web",
            "timeZone": str(self.config.get("time_zone", "5")),
            "serverId": str(self.config.get("server_id", "9")),
            "model": "browser",
            "requestId": self.config.get("request_id", ""),
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
        }

        data_dir = os.path.join(os.path.dirname(__file__), "Data")
        os.makedirs(data_dir, exist_ok=True)
        self.trackers = {sym: SymbolTracker(sym, data_dir) for sym in self.symbols}
        self.session = requests.Session()

    def fetch_latest(self, symbol, size=5):
        payload = {
            "period": 1,
            "symbol": symbol,
            "size": size,
            "to": "",
            "account": self.account,
            "source": self.source
        }
        try:
            res = self.session.post(self.kline_url, headers=self.headers, json=payload, timeout=5)
            if res.status_code == 200:
                data = res.json()
                if data.get("code") == 0 and "data" in data and "klines" in data["data"]:
                    return data["data"]["klines"]
        except Exception:
            pass
        return None

    def git_sync(self):
        """Pushes current data to GitHub during long-running actions"""
        if os.environ.get("GITHUB_ACTIONS") == "true":
            try:
                subprocess.run(["git", "config", "--global", "user.name", "github-actions[bot]"], check=False)
                subprocess.run(["git", "config", "--global", "user.email", "github-actions[bot]@users.noreply.github.com"], check=False)
                subprocess.run(["git", "add", "Data/*.csv"], check=False)
                res = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True)
                if res.stdout.strip():
                    total_new = sum(t.tick_count for t in self.trackers.values())
                    subprocess.run(["git", "commit", "-m", f"Auto-sync live multi-asset ticks: {total_new} entries [skip ci]"], check=False)
                    subprocess.run(["git", "pull", "--rebase", "origin", "main"], check=False)
                    subprocess.run(["git", "push", "origin", "main"], check=False)
                    print(f"[GitHub Actions Sync] Pushed multi-asset ticks to repository.")
            except Exception as e:
                print(f"[GitHub Actions Sync] Warning: {e}")

def run_collector(duration_seconds=14400, poll_interval=0.5, symbols=None):
    collector = VantageMultiAssetCollector(symbols=symbols)
    print(f"\n=================================================================")
    print(f"   VANTAGE MULTI-ASSET CLOUD TICK COLLECTOR (v8.5 PRO)           ")
    print(f"=================================================================")
    print(f"Tracking Assets: {', '.join(collector.symbols)}")
    print(f"Max Duration   : {duration_seconds}s ({duration_seconds/3600:.1f} hours)")
    print(f"Poll Interval  : {poll_interval}s\n")

    # Pre-seed historical candles for each asset
    for sym, tracker in collector.trackers.items():
        init_klines = collector.fetch_latest(sym, size=50)
        if init_klines:
            seeded = 0
            for k in init_klines:
                if tracker.log_tick(k["close"], k["timestamp"] * 1000, k.get("volume", 0)):
                    seeded += 1
            tracker.flush()
            if seeded > 0:
                print(f"[{sym}] Seeded {seeded} historical candles.")

    start_time = time.time()
    last_sync = time.time()

    while (time.time() - start_time) < duration_seconds:
        try:
            for sym, tracker in collector.trackers.items():
                klines = collector.fetch_latest(sym, size=2)
                if klines and len(klines) > 0:
                    curr = klines[-1]
                    ts_ms = curr["timestamp"] * 1000
                    price = curr["close"]
                    vol = curr.get("volume", 0)

                    if price != tracker.last_price or ts_ms != tracker.last_ts:
                        tracker.last_price = price
                        tracker.last_ts = ts_ms
                        if tracker.log_tick(price, ts_ms, vol):
                            dt_now = datetime.fromtimestamp(ts_ms / 1000.0).strftime('%H:%M:%S')
                            print(f"[{sym} TICK] {dt_now} | Price: {price} | Vol: {vol} (Saved: {tracker.tick_count})")

            # Periodic git push every 10 minutes in GitHub Actions
            if time.time() - last_sync >= 600:
                collector.git_sync()
                last_sync = time.time()

            time.sleep(poll_interval)
        except KeyboardInterrupt:
            break
        except Exception:
            time.sleep(poll_interval)

    for tracker in collector.trackers.values():
        tracker.flush()
    collector.git_sync()

    print(f"\n=================================================================")
    print(f"   COLLECTION FINISHED                                           ")
    print(f"=================================================================")
    for sym, tracker in collector.trackers.items():
        print(f" - {sym:<10}: {tracker.tick_count} new ticks recorded -> {tracker.output_file}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Vantage Multi-Asset Tick Collector")
    parser.add_argument("--duration", type=int, default=14400, help="Duration in seconds")
    parser.add_argument("--duration-hours", type=float, default=None, help="Duration in hours")
    parser.add_argument("--interval", type=float, default=0.5, help="Poll interval in seconds")
    parser.add_argument("--symbols", type=str, default=None, help="Comma separated symbols e.g. USDJPY,XAUUSD,EURUSD,NAS100")
    args = parser.parse_args()
    
    symbols_list = args.symbols.split(",") if args.symbols else None
    duration = int(args.duration_hours * 3600) if args.duration_hours else args.duration
    run_collector(duration, args.interval, symbols_list)
