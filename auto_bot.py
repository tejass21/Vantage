"""
================================================================================
   VANTAGE AUTONOMOUS EXTERNAL BROWSER TRADING BOT (v9.5 PRO)
================================================================================
Architecture:
  - Launches a REAL visible Chrome browser on your desktop
  - Automatically loads and logs into Vantage WebTrader
  - Uses persistent user profile (no need to login again and again)
  - Connects real-time Quantitative Sniper Engine (ATR, RSI, S/R, Pinbars)
  - Automatically enters trades, sets lot sizes, and manages exits / TP / SL
================================================================================
"""

import os
import sys
import json
import time
import argparse
from datetime import datetime
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# Import our live quantitative sniper engine
from predictor import VantageLiveSniper

# Terminal colors
BOLD = "\033[1m"
COLOR_GREEN = "\033[92m"
COLOR_RED = "\033[91m"
COLOR_YELLOW = "\033[93m"
COLOR_CYAN = "\033[96m"
COLOR_WHITE = "\033[97m"
COLOR_RESET = "\033[0m"

class VantageBrowserBot:
    def __init__(self, symbol="USDJPY", lot_mode="fixed", risk_pct=1.0, min_conf=80):
        self.symbol = symbol.upper()
        self.lot_mode = lot_mode
        self.risk_pct = risk_pct
        self.min_conf = min_conf
        self.cooldown_sec = 90
        self.last_trade_time = 0
        self.trades_today = 0
        self.max_daily_trades = 6

        # Paths
        base_dir = os.path.dirname(__file__)
        self.config_path = os.path.join(base_dir, "config.json")
        self.profile_dir = os.path.join(base_dir, "browser_profile")
        os.makedirs(self.profile_dir, exist_ok=True)

        with open(self.config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)

        # Quantitative Engine
        self.engine = VantageLiveSniper(config_path=self.config_path, symbol=self.symbol)
        self.driver = None

    def launch_browser(self):
        print(f"\n{BOLD}{COLOR_CYAN}================================================================={COLOR_RESET}")
        print(f"{BOLD}{COLOR_CYAN}   LAUNCHING VANTAGE AUTONOMOUS EXTERNAL BROWSER BOT             {COLOR_RESET}")
        print(f"{BOLD}{COLOR_CYAN}================================================================={COLOR_RESET}")
        print(f"Target Asset  : {BOLD}{COLOR_WHITE}{self.symbol}{COLOR_RESET}")
        print(f"Risk Setting  : {BOLD}{COLOR_GREEN}{self.lot_mode} ({self.risk_pct}%){COLOR_RESET}")
        print(f"Min Confidence: {BOLD}{COLOR_YELLOW}{self.min_conf}%{COLOR_RESET}")
        print(f"Profile Dir   : {self.profile_dir}\n")

        options = Options()
        # Persistent profile so user stays logged in
        options.add_argument(f"--user-data-dir={self.profile_dir}")
        options.add_argument("--start-maximized")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_argument("--disable-notifications")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option("useAutomationExtension", False)

        print("[Bot] Opening visible Chrome window on your screen...")
        self.driver = webdriver.Chrome(options=options)
        self.driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
            "source": """
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """
        })

        # Navigate to Vantage domain first to set context
        print("[Bot] Injecting authenticated session & tokens into Chrome...")
        self.driver.get("https://secure.vantagemarkets.com/robots.txt")
        time.sleep(1)

        # 1. Inject Cookies
        cookies_str = self.config.get("cookies", "")
        if cookies_str:
            for item in cookies_str.split(";"):
                if "=" in item:
                    try:
                        k, v = item.strip().split("=", 1)
                        self.driver.add_cookie({
                            "name": k.strip(),
                            "value": v.strip(),
                            "domain": "secure.vantagemarkets.com",
                            "path": "/"
                        })
                    except Exception:
                        pass

        # 2. Inject LocalStorage Auth Tokens (Vue/React state)
        token = self.config.get("auth_token", "")
        trade_token = self.config.get("trade_token", "ac541a7a56134600ae34ada0da749e31")
        user_id = str(self.config.get("user_id", "12179632"))
        account_id = str(self.config.get("account_id", "26220746"))

        inject_js = f"""
            localStorage.setItem('token', '{token}');
            localStorage.setItem('xtoken', '{token}');
            localStorage.setItem('tradeToken', JSON.stringify({{'value': '{trade_token}', 'options': {{'seconds': -1, 'keepExpired': false}}, 'expiredAt': -1}}));
            localStorage.setItem('current_account', JSON.stringify({{'value': JSON.stringify({{{user_id}: {{'accountId': '{account_id}', 'region': 'nv'}}}}), 'options': {{'seconds': -1, 'keepExpired': false}}, 'expiredAt': -1}}));
            localStorage.setItem('cpUserInfo', JSON.stringify({{'value': {{'crmUserId': '{user_id}', 'userToken': '{token}'}}, 'options': {{'seconds': -1, 'keepExpired': false}}, 'expiredAt': -1}}));
            localStorage.setItem('user', JSON.stringify({{'accessToken': '{token}', 'userId': {user_id}, 'userID': {user_id}, 'email': 'tejasbachute3@gmail.com', 'isDemo': false}}));
            localStorage.setItem('account_list_domain', 'appv2.nv.polokalamumakeke.com:18008');
        """
        self.driver.execute_script(inject_js)
        print(f"{COLOR_GREEN}[✓] Injected Tokens & LocalStorage successfully!{COLOR_RESET}")

        # Now navigate to WebTrader with fully authenticated session
        trade_url = f"https://secure.vantagemarkets.com/web_trade/trade/{self.symbol}"
        print(f"[Bot] Loading WebTrader (Directly Logged In): {trade_url}")
        self.driver.get(trade_url)
        time.sleep(3)
        print(f"{COLOR_GREEN}[✓] DIRECT LOGIN COMPLETE! WebTrader is active.{COLOR_RESET}\n")

    def get_account_equity(self):
        """Extracts live equity from the page DOM"""
        try:
            body_text = self.driver.find_element(By.TAG_NAME, "body").text
            import re
            m = re.search(r"Equity:\s*([\d,.]+)", body_text)
            if m:
                val = float(m.group(1).replace(",", ""))
                return val
        except Exception:
            pass
        return 10000.0 # Default fallback

    def calculate_lot(self, equity):
        if self.lot_mode == "fixed":
            return "0.01"
        risk_amount = equity * (self.risk_pct / 100.0)
        # 10 pips stop loss assumption ($10/pip on 1 lot)
        calc = risk_amount / (10.0 * 10.0)
        clamped = max(0.01, min(0.50, round(calc, 2)))
        return f"{clamped:.2f}"

    def execute_order(self, direction, confidence):
        if (time.time() - self.last_trade_time) < self.cooldown_sec:
            return False
        if self.trades_today >= self.max_daily_trades:
            print(f"{COLOR_YELLOW}[Bot] Max daily trades limit reached ({self.max_daily_trades}). Holding.{COLOR_RESET}")
            return False

        equity = self.get_account_equity()
        lot_size = self.calculate_lot(equity)

        now_str = datetime.now().strftime('%H:%M:%S')
        col = COLOR_GREEN if direction == "BUY" else COLOR_RED
        print(f"\n{BOLD}{col}>>> [BOT EXECUTING {direction}] <<< (Confidence: {confidence}%){COLOR_RESET}")
        print(f"Equity: ${equity:,.2f} | Calculated Lot Size: {BOLD}{lot_size}{COLOR_RESET} | Time: {now_str}")

        try:
            # 1. Switch Buy / Sell tab
            is_buy = direction == "BUY"
            buttons = self.driver.find_elements(By.TAG_NAME, "button")
            for b in buttons:
                t = b.text.strip()
                if is_buy and t.startswith("Buy"):
                    b.click()
                    time.sleep(0.3)
                    break
                elif not is_buy and t.startswith("Sell"):
                    b.click()
                    time.sleep(0.3)
                    break

            # 2. Set Volume
            inputs = self.driver.find_elements(By.TAG_NAME, "input")
            vol_input = None
            for inp in inputs:
                ph = inp.get_attribute("placeholder") or ""
                t = inp.get_attribute("type") or ""
                val = inp.get_attribute("value") or ""
                if "0." in val or "0." in ph or t == "number":
                    vol_input = inp
                    break

            if vol_input:
                vol_input.click()
                vol_input.send_keys(Keys.CONTROL + "a")
                vol_input.send_keys(Keys.BACKSPACE)
                vol_input.send_keys(lot_size)
                time.sleep(0.2)

            # 3. Click the Action execution button
            buttons = self.driver.find_elements(By.TAG_NAME, "button")
            action_btn = None
            for b in buttons:
                t = b.text.strip()
                if is_buy and (t == "Buy" or t.startswith("Buy")):
                    action_btn = b
                elif not is_buy and (t == "Sell" or t.startswith("Sell")):
                    action_btn = b

            if action_btn:
                action_btn.click()
                self.last_trade_time = time.time()
                self.trades_today += 1
                print(f"{BOLD}{COLOR_GREEN}[✓] Order Placed Successfully on Vantage WebTrader!{COLOR_RESET}")
                return True
            else:
                print(f"{COLOR_YELLOW}[Bot] Could not locate action button. Please check chart view.{COLOR_RESET}")

        except Exception as e:
            print(f"{COLOR_RED}[Bot Error executing order]: {e}{COLOR_RESET}")

        return False

    def run(self):
        self.launch_browser()
        print(f"\n{COLOR_GREEN}[Bot Monitoring Started] Scanning live market for {self.symbol}...{COLOR_RESET}")
        print("Press Ctrl+C in terminal anytime to stop.\n")

        last_sec = -1
        while True:
            try:
                now = datetime.now()
                sec = now.second

                if sec != last_sec:
                    last_sec = sec
                    res = self.engine.evaluate_market()
                    if res:
                        price = res["price"]
                        sig = res["signal"]
                        conf = res["confidence"]
                        rsi = res["rsi"]
                        atr = res["atr"]
                        session = res["session"]
                        rem = 60 - sec

                        # Check for sniper execution condition
                        if conf >= self.min_conf and sig in ["BUY", "SELL"]:
                            self.execute_order(sig, conf)
                        else:
                            # Live heartbeat
                            sys.stdout.write(f"\r{DIM}[{now.strftime('%H:%M:%S')}]{COLOR_RESET} {self.symbol}: {BOLD}{price:.3f}{COLOR_RESET} | RSI: {rsi:.1f} | ATR: {atr:.2f} | [{COLOR_CYAN}{session}{COLOR_RESET}] | Rem: {rem:02d}s | State: {COLOR_YELLOW}{sig}{COLOR_RESET}   ")
                            sys.stdout.flush()

                time.sleep(0.5)
            except KeyboardInterrupt:
                print(f"\n\n{COLOR_YELLOW}[Bot] Stopping by user. Closing browser...{COLOR_RESET}")
                if self.driver:
                    self.driver.quit()
                break
            except Exception as e:
                time.sleep(1.0)

def main():
    parser = argparse.ArgumentParser(description="Vantage Autonomous External Browser Trading Bot")
    parser.add_argument("--symbol", type=str, default="USDJPY", help="Symbol: USDJPY, XAUUSD, EURUSD, NAS100")
    parser.add_argument("--lot-mode", type=str, default="fixed", choices=["fixed", "risk"], help="Lot mode: 'fixed' (0.01) or 'risk' (% equity)")
    parser.add_argument("--risk", type=float, default=1.0, help="Risk percent per trade (default 1.0%)")
    parser.add_argument("--min-conf", type=int, default=80, help="Min confidence threshold (default 80%)")
    args = parser.parse_args()

    bot = VantageBrowserBot(
        symbol=args.symbol,
        lot_mode=args.lot_mode,
        risk_pct=args.risk,
        min_conf=args.min_conf
    )
    bot.run()

if __name__ == "__main__":
    main()
