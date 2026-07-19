import base64
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"
base_url = os.environ.get("DOCKERBRIDGE_TEST_URL", "http://127.0.0.1:28612")
username = os.environ["DOCKERBRIDGE_TEST_USERNAME"]
password = os.environ["DOCKERBRIDGE_TEST_PASSWORD"]
output_dir = Path(os.environ.get("DOCKERBRIDGE_TEST_OUTPUT", "/tmp/dockerbridge-react-ui"))
output_dir.mkdir(parents=True, exist_ok=True)


def available_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class Browser:
    def __init__(self):
        self.port = available_port()
        self.endpoint = f"http://127.0.0.1:{self.port}"
        self.process = subprocess.Popen(
            ["geckodriver", "--port", str(self.port), "--log", "info"],
            stdout=(output_dir / "geckodriver.log").open("w", encoding="utf-8"),
            stderr=subprocess.STDOUT,
        )
        self.session = ""
        self._wait_for_driver()
        response = self.request(
            "POST",
            "/session",
            {
                "capabilities": {
                    "alwaysMatch": {
                        "browserName": "firefox",
                        "acceptInsecureCerts": True,
                        "moz:firefoxOptions": {
                            "args": ["-headless"],
                            "prefs": {
                                "browser.cache.disk.enable": False,
                                "browser.cache.memory.enable": False,
                                "dom.serviceWorkers.enabled": False,
                            },
                        },
                    }
                }
            },
        )
        self.session = response["sessionId"]

    def _wait_for_driver(self):
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                self.request("GET", "/status")
                return
            except Exception:
                time.sleep(0.2)
        raise TimeoutError("geckodriver did not become ready")

    def request(self, method, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8")
            raise RuntimeError(f"WebDriver {method} {path} failed: {details}") from error
        return body.get("value")

    def command(self, method, path, payload=None):
        return self.request(method, f"/session/{self.session}{path}", payload)

    def set_size(self, width, height):
        self.command("POST", "/window/rect", {"width": width, "height": height})

    def navigate(self, path):
        self.command("POST", "/url", {"url": f"{base_url}{path}"})

    def current_url(self):
        return self.command("GET", "/url")

    def element(self, selector, using="css selector"):
        return self.command("POST", "/element", {"using": using, "value": selector})[ELEMENT_KEY]

    def elements(self, selector, using="css selector"):
        return [item[ELEMENT_KEY] for item in self.command("POST", "/elements", {"using": using, "value": selector})]

    def click(self, element):
        self.command("POST", f"/element/{element}/click", {})

    def type(self, element, text):
        self.command("POST", f"/element/{element}/value", {"text": text, "value": list(text)})

    def execute(self, script, arguments=None):
        return self.command("POST", "/execute/sync", {"script": script, "args": arguments or []})

    def wait(self, predicate, description, timeout=90):
        deadline = time.time() + timeout
        last_error = None
        while time.time() < deadline:
            try:
                if predicate():
                    return
            except Exception as error:
                last_error = error
            time.sleep(0.25)
        suffix = f": {last_error}" if last_error else ""
        raise TimeoutError(f"Timed out waiting for {description}{suffix}")

    def wait_text(self, text, timeout=90):
        self.wait(
            lambda: self.execute("return document.body && document.body.innerText.includes(arguments[0]);", [text]),
            f"text {text}",
            timeout,
        )

    def screenshot(self, name):
        encoded = self.command("GET", "/screenshot")
        (output_dir / name).write_bytes(base64.b64decode(encoded))

    def close(self):
        if self.session:
            try:
                self.request("DELETE", f"/session/{self.session}")
            except Exception:
                pass
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()


browser = Browser()
results = []


def record(name, details=None):
    results.append({"name": name, "ok": True, "details": details or {}})


def assert_no_overflow(name):
    dimensions = browser.execute(
        "return {scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth};"
    )
    if dimensions["scroll"] > dimensions["client"] + 1:
        raise AssertionError(f"{name} horizontal overflow: {dimensions}")
    record(f"{name}-no-horizontal-overflow", dimensions)


def open_route(path, heading):
    browser.navigate(path)
    browser.wait_text(heading)
    assert_no_overflow(path or "dashboard")


try:
    browser.set_size(1440, 1000)
    browser.navigate("/login")
    browser.wait(lambda: len(browser.elements("input[autocomplete='username']")) == 1, "login form")
    browser.type(browser.element("input[autocomplete='username']"), username)
    browser.type(browser.element("input[type='password']"), password)
    browser.click(browser.element("button[type='submit']"))
    browser.wait(lambda: browser.current_url().rstrip("/") == base_url.rstrip("/"), "dashboard URL")
    browser.wait_text("运行状态")
    browser.wait_text("本地镜像")
    browser.wait_text("35")
    browser.screenshot("desktop-dashboard.png")
    assert_no_overflow("desktop-dashboard")
    record("login")

    open_route("/containers", "Docker 资源")
    browser.wait_text("容器 40")
    browser.screenshot("desktop-containers.png")
    record("containers", {"rows": len(browser.elements("tbody tr"))})

    open_route("/compose", "已登记的 Compose 项目")
    compose_rows = len(browser.elements("tbody tr"))
    if compose_rows == 0:
        raise AssertionError("Expected at least one registered Compose project")
    browser.screenshot("desktop-compose-projects.png")
    record("compose-projects", {"rows": compose_rows})

    open_route("/compose-repository", "Compose 配置索引")
    browser.wait_text("第 1 / 7 页", 120)
    browser.wait_text("348")
    repository_rows = len(browser.elements("tbody tr"))
    if repository_rows != 50:
        raise AssertionError(f"Expected 50 repository rows, got {repository_rows}")
    browser.screenshot("desktop-compose-repository.png")
    record("compose-repository", {"rows": repository_rows})

    search = browser.element("input[placeholder*='项目名']")
    browser.type(search, "gzctf")
    browser.execute("arguments[0].closest('form').requestSubmit();", [{ELEMENT_KEY: search}])
    browser.wait_text("共 1 项")
    browser.wait_text("gzctf")
    record("repository-search")

    browser.navigate("/compose-repository")
    browser.wait_text("共 348 项")
    browser.execute(
        "const select=document.querySelectorAll('select')[1]; select.value='running'; select.dispatchEvent(new Event('change',{bubbles:true}));"
    )
    browser.wait_text("共 6 项")
    if len(browser.elements("tbody tr")) != 6:
        raise AssertionError("Running filter did not return six rows")
    record("repository-running-filter")

    browser.execute(
        "const select=document.querySelectorAll('select')[1]; select.value='all'; select.dispatchEvent(new Event('change',{bubbles:true}));"
    )
    browser.wait_text("共 348 项")
    browser.click(browser.element("//button[contains(normalize-space(), '下一页')]", "xpath"))
    browser.wait_text("第 2 / 7 页")
    record("repository-pagination")

    open_route("/settings", "平台设置")
    browser.screenshot("desktop-settings.png")
    record("settings")

    open_route("/console", "主机终端")
    browser.wait(lambda: len(browser.elements(".xterm")) == 1, "terminal")
    browser.screenshot("desktop-console.png")
    record("console")

    browser.set_size(500, 900)
    browser.navigate("/compose-repository")
    browser.wait_text("Compose 配置索引")
    browser.wait_text("第 1 / 7 页", 120)
    mobile_navigation = browser.elements("nav[aria-label='移动端主导航'] a")
    if len(mobile_navigation) != 4:
        raise AssertionError(f"Expected four mobile navigation items, got {len(mobile_navigation)}")
    assert_no_overflow("mobile-compose-repository")
    browser.screenshot("mobile-compose-repository.png")
    record("mobile-navigation", {"items": len(mobile_navigation)})

    browser.click(browser.element("button[aria-label='打开导航']"))
    browser.wait(lambda: len(browser.elements("button[aria-label='关闭导航']")) == 1, "mobile sidebar")
    time.sleep(0.35)
    browser.screenshot("mobile-sidebar.png")
    record("mobile-sidebar")

    print(json.dumps({"ok": True, "results": results, "screenshots": str(output_dir)}, ensure_ascii=False, indent=2))
except Exception as error:
    try:
        browser.screenshot("failure.png")
    except Exception:
        pass
    print(json.dumps({"ok": False, "error": str(error), "results": results, "screenshots": str(output_dir)}, ensure_ascii=False, indent=2))
    raise
finally:
    browser.close()
