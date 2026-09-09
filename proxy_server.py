import http.server
import socketserver
import urllib.request

CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTHzn77J2xBJtuPT3I_umOpYNuJHWY3b2Sz_eN-V6z8YYFm7qhQt2ppQbInhTcNIuEiZUUjJfIrmfzx/pub?gid=1347234845&single=true&output=csv"

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/sheet.csv"):
            try:
                req = urllib.request.Request(CSV_URL, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                msg = str(e).encode()
                self.send_response(502)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
        else:
            super().do_GET()

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    with socketserver.TCPServer(("127.0.0.1", 8000), Handler) as httpd:
        print("Serving on http://localhost:8000  (CSV proxy at /sheet.csv)")
        httpd.serve_forever()
