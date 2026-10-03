#!/usr/bin/env python3
"""Runs curl for the runner, which has no HTTP/3 of its own. Only on the rig's internal network."""
import json
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        if self.path != "/curl":
            self.send_error(404)
            return
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        with tempfile.NamedTemporaryFile("w", suffix=".pem") as ca:
            ca.write(request.get("ca", ""))
            ca.flush()
            try:
                done = subprocess.run(
                    ["curl", "--cacert", ca.name, *request["args"]],
                    capture_output=True, text=True, timeout=40, check=False,
                )
                result = {"rc": done.returncode, "stdout": done.stdout, "stderr": done.stderr}
            except subprocess.TimeoutExpired:
                result = {"rc": 28, "stdout": "", "stderr": "timed out"}
        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        self.send_response(200 if self.path == "/health" else 404)
        self.send_header("Content-Length", "0")
        self.end_headers()


ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
