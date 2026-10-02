"""
================================================================================
   VANTAGE CLOUD TICK & CANDLE DATA COLLECTOR (v8.0 PRO)
================================================================================
Continuously fetches real-time market data from Vantage's live institutional
stream API and saves ticks into Vantage/Data/USDJPY_ticks.csv.
================================================================================
"""

import time
import json
import os
import sys
import argparse
from datetime import datetime
import requests

class VantageDataCollector:
    def __init__(self, config_path=None, output_file=None):
        if not config_path:
            config_path = os.path.join(os.path.dirname(__file__), "config.json")
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)

        self.target = self.config.get("target_asset", "USDJPY")
        self.kline_url = self.config.get("kline_url", "https://appv2.nv.polokalamumakeke.com:18008/api/kline/query")
        
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

        self.account = self.config.get("account_id", "26220746")
        self.source = self.config.get("source", 3012)
        
        if not output_file:
            data_dir = os.path.join(os.path.dirname(__file__), "Data")
            os.makedirs(data_dir, exist_ok=True)
            self.output_file = os.path.join(data_dir, f"{self.target}_ticks.csv")
        else:
            self.output_file = output_file

        os.makedirs(os.path.dirname(self.output_file), exist_ok=True)
        if not os.path.exists(self.output_file):
            with open(self.output_file, "w", encoding="utf-8") as f:
                f.write("timestamp_ms,price,datetime,volume\n")

        self.session = requests.Session()
        self.last_ts = 0
        self.last_price = 0
        self.tick_count = 0
        self.buffer = []

    def log_tick(self, price, ts_ms, vol=0):
        dt_str = datetime.fromtimestamp(ts_ms / 1000.0).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
        self.buffer.append(f"{ts_ms},{price},{dt_str},{vol}\n")
        self.tick_count += 1
        self.flush()

    def flush(self):
        if not self.buffer:
            return
        with open(self.output_file, "a", encoding="utf-8") as f:
            f.writelines(self.buffer)
        self.buffer.clear()

    def fetch_latest(self, size=5):
        payload = {
            "period": 1,
            "symbol": self.target,
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
        except Exception as e:
            pass
        return None

def run_collector(duration_seconds=14400, poll_interval=1.0):
    collector = VantageDataCollector()
    print(f"\n[Vantage Collector] Started polling live ticks for {collector.target}")
    print(f"[Vantage Collector] Target CSV: {collector.output_file}")
    print(f"[Vantage Collector] Poll Interval: {poll_interval}s | Max duration: {duration_seconds}s\n")

    start_time = time.time()
    last_report = time.time()

    # Pre-seed with historical data
    init_klines = collector.fetch_latest(size=50)
    if init_klines:
        print(f"[Vantage Collector] Successfully seeded {len(init_klines)} historical candles.")
        for k in init_klines:
            collector.log_tick(k["close"], k["timestamp"] * 1000, k.get("volume", 0))
        collector.flush()

    while (time.time() - start_time) < duration_seconds:
        try:
            klines = collector.fetch_latest(size=2)
            if klines and len(klines) > 0:
                curr = klines[-1]
                ts_ms = curr["timestamp"] * 1000
                price = curr["close"]
                vol = curr.get("volume", 0)

                # Check if price changed or timestamp advanced
                if price != collector.last_price or ts_ms != collector.last_ts:
                    collector.last_price = price
                    collector.last_ts = ts_ms
                    collector.log_tick(price, ts_ms, vol)
                    dt_now = datetime.fromtimestamp(ts_ms / 1000.0).strftime('%H:%M:%S')
                    print(f"[TICK SAVED] {dt_now} | Price: {price:.3f} | Vol: {vol} (Total Saved: {collector.tick_count})")

            time.sleep(poll_interval)
        except KeyboardInterrupt:
            break
        except Exception as e:
            time.sleep(poll_interval)

    collector.flush()
    print(f"\n[Vantage Collector] Finished. Total ticks recorded: {collector.tick_count}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Vantage Tick & Candle Collector")
    parser.add_argument("--duration", type=int, default=14400, help="Duration in seconds")
    parser.add_argument("--duration-hours", type=float, default=None, help="Duration in hours")
    parser.add_argument("--interval", type=float, default=0.5, help="Poll interval in seconds")
    args = parser.parse_args()
    duration = int(args.duration_hours * 3600) if args.duration_hours else args.duration
    run_collector(duration, args.interval)
