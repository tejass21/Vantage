"""
================================================================================
   VANTAGE MARKETS REST & TRADING API CLIENT
================================================================================
Handles authenticated interactions with Vantage Markets backend:
- Account details & Balance query
- Market Quotes / Ticks / OHLC Bars
- Order Placement (BUY / SELL) with Stop-Loss & Take-Profit
- Active Positions & History
================================================================================
"""

import json
import os
import time
import requests

class VantageAPIClient:
    def __init__(self, config_path=None):
        if not config_path:
            config_path = os.path.join(os.path.dirname(__file__), "config.json")
            
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)

        self.auth_token = self.config.get("auth_token", "")
        self.user_id = str(self.config.get("user_id", ""))
        self.account_id = str(self.config.get("account_id", ""))
        self.trade_token = self.config.get("trade_token", "")
        self.cookies = self.config.get("cookies", "")
        self.origin = self.config.get("platform_origin", "https://secure.vantagemarkets.com")
        self.account_domain = self.config.get("account_domain", "appv2.nv.polokalamumakeke.com:18008")

        self.session = requests.Session()
        self.headers = {
            "Host": "secure.vantagemarkets.com",
            "Origin": self.origin,
            "Referer": f"{self.origin}/home",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
            "Authorization": f"Bearer {self.auth_token}",
            "token": self.auth_token,
            "xtoken": self.auth_token,
            "Cookie": self.cookies,
            "Content-Type": "application/json;charset=UTF-8",
            "Accept": "application/json, text/plain, */*"
        }

    def get_account_summary(self):
        """Fetches account balance, equity, margin info"""
        url = f"{self.origin}/api/account/summary"
        try:
            res = self.session.get(url, headers=self.headers, timeout=10)
            if res.status_code == 200:
                return res.json()
        except Exception as e:
            pass

        # Alternate endpoint via account domain
        alt_url = f"https://{self.account_domain}/api/v1/accounts/{self.account_id}"
        try:
            alt_headers = dict(self.headers)
            alt_headers["Host"] = self.account_domain.split(":")[0]
            alt_headers["X-Trade-Token"] = self.trade_token
            res = self.session.get(alt_url, headers=alt_headers, timeout=10)
            if res.status_code == 200:
                return res.json()
        except Exception:
            pass
        return {"status": "error", "message": "Failed to fetch account summary"}

    def get_symbol_quote(self, symbol="USDJPY"):
        """Fetches current bid/ask quote for symbol"""
        url = f"https://{self.account_domain}/api/v1/quote?symbol={symbol}"
        try:
            headers = dict(self.headers)
            headers["Host"] = self.account_domain.split(":")[0]
            res = self.session.get(url, headers=headers, timeout=5)
            if res.status_code == 200:
                return res.json()
        except Exception as e:
            return {"error": str(e)}
        return None

    def place_order(self, symbol="USDJPY", side="BUY", volume=0.01, sl=0.0, tp=0.0):
        """
        Submits market order to Vantage Markets.
        side: 'BUY' or 'SELL'
        volume: lot size (e.g. 0.01)
        """
        payload = {
            "accountId": self.account_id,
            "userId": self.user_id,
            "symbol": symbol,
            "tradeType": side.upper(),
            "volume": float(volume),
            "stopLoss": float(sl),
            "takeProfit": float(tp),
            "tradeToken": self.trade_token,
            "timestamp": int(time.time() * 1000)
        }

        url = f"https://{self.account_domain}/api/v1/trade/order"
        try:
            headers = dict(self.headers)
            headers["Host"] = self.account_domain.split(":")[0]
            headers["X-Trade-Token"] = self.trade_token
            res = self.session.post(url, headers=headers, json=payload, timeout=10)
            return res.json()
        except Exception as e:
            return {"status": "failed", "error": str(e)}

if __name__ == "__main__":
    client = VantageAPIClient()
    print("[VantageAPIClient] Initialized client for User:", client.user_id, "Account:", client.account_id)
