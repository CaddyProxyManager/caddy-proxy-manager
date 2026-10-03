#!/usr/bin/env python3
"""Simulated proxy destinations for the caddy-proxy-manager docker test rig.

One script, several modes, chosen by argv[1]:

    http  PORT              plain HTTP origin (also speaks WebSocket on /ws)
    https PORT CERT KEY     the same origin behind TLS
    tcp   PORT              raw TCP line echo, no protocol awareness
    udp   PORT              raw UDP datagram echo
    files PORT CERT KEY DIR static files over TLS, standing in for third-party hosts

The HTTP origin reflects everything the proxy did to a request - the Host it
forwarded, every header it added, the address it connected from - so the test
suite can assert on proxy behaviour rather than just on reachability.

Only the standard library is used, WebSocket framing included, so the image
needs no package installs and cannot drift.
"""

import base64
import collections
import hashlib
import json
import os
import socket
import socketserver
import ssl
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

ORIGIN_ID = os.environ.get("ORIGIN_ID", "origin")
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
# The Cache-Control values the cache tests ask an origin for.
CACHE_CONTROL_VALUES = {v: v for v in ("no-store", "no-cache", "private", "public, max-age=60")}
# Every request but /__*, for asserting that one never arrived or what a subrequest carried.
REQUEST_LOG = collections.deque(maxlen=500)
REQUEST_LOG_LOCK = threading.Lock()


# ── HTTP / HTTPS ────────────────────────────────────────────────────────────


class OriginHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "cpm-test-origin"
    sys_version = ""

    def log_message(self, fmt, *args):  # noqa: D102 - quieter, one line per request
        sys.stderr.write("[%s] %s - %s\n" % (ORIGIN_ID, self.client_address[0], fmt % args))

    # -- helpers ------------------------------------------------------------

    def _send_json(self, payload, status=200, extra_headers=None):
        body = json.dumps(payload, indent=None, sort_keys=True).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Origin-Id", ORIGIN_ID)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text, status=200, content_type="text/plain; charset=utf-8"):
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Origin-Id", ORIGIN_ID)
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return ""
        try:
            return self.rfile.read(length).decode("utf-8", "replace")
        except Exception:
            return ""

    def _split_path(self):
        path, _, query = self.path.partition("?")
        return path, query

    def _reflect(self):
        path, query = self._split_path()
        return {
            "origin": ORIGIN_ID,
            "method": self.command,
            "path": path,
            "query": query,
            "raw_path": self.path,
            "host": self.headers.get("Host", ""),
            "protocol": self.request_version,
            "peer": self.client_address[0],
            "body": self._read_body(),
            # Header names are lower-cased so assertions do not have to guess
            # which casing the proxy chose to forward.
            "headers": {k.lower(): v for k, v in self.headers.items()},
        }

    # -- websocket ----------------------------------------------------------

    def _is_websocket_upgrade(self):
        upgrade = (self.headers.get("Upgrade") or "").lower()
        connection = (self.headers.get("Connection") or "").lower()
        return upgrade == "websocket" and "upgrade" in connection

    def _websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self._send_text("missing Sec-WebSocket-Key", status=400)
            return
        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode()).digest()
        ).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.send_header("X-Origin-Id", ORIGIN_ID)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        try:
            self._websocket_echo_loop()
        except (OSError, ConnectionError):
            pass

    def _ws_recv_frame(self):
        header = self.rfile.read(2)
        if len(header) < 2:
            return None, None
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self.rfile.read(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self.rfile.read(8))[0]
        mask = self.rfile.read(4) if masked else b""
        payload = self.rfile.read(length) if length else b""
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    def _ws_send_frame(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(length)
        elif length < (1 << 16):
            header.append(126)
            header += struct.pack(">H", length)
        else:
            header.append(127)
            header += struct.pack(">Q", length)
        self.wfile.write(bytes(header) + payload)
        self.wfile.flush()

    def _websocket_echo_loop(self):
        # Announce ourselves so a client can prove which origin it reached
        # without having to send anything first.
        self._ws_send_frame(0x1, ("hello from " + ORIGIN_ID).encode())
        while True:
            opcode, payload = self._ws_recv_frame()
            if opcode is None or opcode == 0x8:  # closed
                return
            if opcode == 0x9:  # ping
                self._ws_send_frame(0xA, payload)
                continue
            if opcode in (0x1, 0x2):
                self._ws_send_frame(opcode, b"echo:" + payload)

    # -- routes -------------------------------------------------------------

    def _dispatch(self):
        path, query = self._split_path()

        if path == "/__health":
            self._send_text("ok")
            return

        if path == "/__requests":
            with REQUEST_LOG_LOCK:
                self._send_json(list(REQUEST_LOG))
            return

        if not path.startswith("/__"):
            entry = {
                "method": self.command,
                "raw_path": self.path,
                "peer": self.client_address[0],
                "headers": {k.lower(): v for k, v in self.headers.items()},
            }
            with REQUEST_LOG_LOCK:
                REQUEST_LOG.append(entry)

        if path == "/ws":
            if self._is_websocket_upgrade():
                self._websocket()
            else:
                self._send_text("expected a websocket upgrade", status=426)
            return

        if path.startswith("/status/"):
            try:
                code = int(path.rsplit("/", 1)[1])
            except ValueError:
                code = 400
            self._send_text("origin returned %d" % code, status=code)
            return

        if path == "/slow":
            millis = 1000
            for part in query.split("&"):
                if part.startswith("ms="):
                    try:
                        millis = int(part[3:])
                    except ValueError:
                        pass
            time.sleep(millis / 1000.0)
            self._send_text("slept %dms" % millis)
            return

        if path == "/large":
            self._send_text("x" * 100000)
            return

        # Compressible bytes behind an image type, so only the type can keep encode off it.
        if path == "/image.png":
            self._send_text("x" * 100000, content_type="image/png")
            return

        # ?cc=, ?cookie= and ?status= shape the response, for the cache tests. Looked up, never
        # echoed: a query string written into a header could add headers of its own.
        params = parse_qs(query)
        extra = {}
        if "cc" in params:
            extra["Cache-Control"] = CACHE_CONTROL_VALUES.get(params["cc"][0], "no-cache")
        if "cookie" in params:
            extra["Set-Cookie"] = "session=test; Path=/"
        status = params.get("status", ["200"])[0]
        status = int(status) if status.isdigit() else 200
        self._send_json(self._reflect(), status=status, extra_headers=extra)

    def do_GET(self):  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        self._dispatch()

    def do_POST(self):  # noqa: N802
        self._dispatch()

    def do_PUT(self):  # noqa: N802
        self._dispatch()

    def do_PATCH(self):  # noqa: N802
        self._dispatch()

    def do_DELETE(self):  # noqa: N802
        self._dispatch()

    def do_HEAD(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.send_header("X-Origin-Id", ORIGIN_ID)
        self.end_headers()


def serve_http(port, certfile=None, keyfile=None):
    httpd = ThreadingHTTPServer(("0.0.0.0", port), OriginHandler)
    httpd.daemon_threads = True
    scheme = "http"
    if certfile:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certfile, keyfile)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"
    print("%s: %s origin listening on :%d" % (ORIGIN_ID, scheme, port), flush=True)
    httpd.serve_forever()


# ── Raw TCP ─────────────────────────────────────────────────────────────────


class TcpEchoHandler(socketserver.StreamRequestHandler):
    # A slow or absent line would otherwise pin a thread forever.
    timeout = 30

    def handle(self):
        peer = self.client_address[0]
        print("%s: tcp connection from %s" % (ORIGIN_ID, peer), flush=True)
        self.wfile.write(("HELLO %s\n" % ORIGIN_ID).encode())
        self.wfile.flush()
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            if text == "QUIT":
                self.wfile.write(b"BYE\n")
                self.wfile.flush()
                return
            self.wfile.write(("ECHO %s %s\n" % (ORIGIN_ID, text)).encode())
            self.wfile.flush()


class ThreadedTcpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def serve_tcp(port):
    print("%s: tcp origin listening on :%d" % (ORIGIN_ID, port), flush=True)
    ThreadedTcpServer(("0.0.0.0", port), TcpEchoHandler).serve_forever()


# ── Raw UDP ─────────────────────────────────────────────────────────────────


def serve_udp(port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    print("%s: udp origin listening on :%d" % (ORIGIN_ID, port), flush=True)
    while True:
        data, addr = sock.recvfrom(65535)
        text = data.decode("utf-8", "replace").strip()
        print("%s: udp datagram from %s: %r" % (ORIGIN_ID, addr[0], text), flush=True)
        sock.sendto(("ECHO %s %s\n" % (ORIGIN_ID, text)).encode(), addr)


# ── Static files for third-party hosts ──────────────────────────────────────
#
# dnsmasq points names like download.maxmind.com here, so a request is answered from
# DIR/<Host>/<path>, the query ignored. Beside a file, `<file>.redirect` holds a Location to send
# instead; in a host's directory, `.auth` holds the Authorization header every request must carry.
# The tests write DIR through a volume they share.

FILES_ROOT = "/srv/files"
FILES_LOG = collections.deque(maxlen=500)


class FilesHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "cpm-test-files"
    sys_version = ""

    def log_message(self, fmt, *args):  # noqa: D102
        sys.stderr.write("[files] %s - %s\n" % (self.client_address[0], fmt % args))

    def _send(self, status, body=b"", headers=None):
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _dispatch(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        path = self.path.split("?", 1)[0]
        if path == "/__requests":
            with REQUEST_LOG_LOCK:
                body = json.dumps(list(FILES_LOG)).encode()
            self._send(200, body, {"Content-Type": "application/json"})
            return
        with REQUEST_LOG_LOCK:
            FILES_LOG.append({
                "host": host,
                "method": self.command,
                "raw_path": self.path,
                "authorization": self.headers.get("Authorization"),
            })

        # The Host header picks the directory, so it must stay under the root as the path must.
        root = os.path.realpath(FILES_ROOT)
        base = os.path.realpath(os.path.join(root, host))
        target = os.path.realpath(os.path.join(base, path.lstrip("/")))
        if not base.startswith(root + os.sep) or not target.startswith(base + os.sep):
            self._send(404, b"not found")
            return
        auth_file = os.path.join(base, ".auth")
        if os.path.isfile(auth_file):
            with open(auth_file, encoding="utf-8") as handle:
                wanted = handle.read().strip()
            if self.headers.get("Authorization") != wanted:
                self._send(401, b"unauthorized", {"WWW-Authenticate": 'Basic realm="rig"'})
                return
        if os.path.isfile(target + ".redirect"):
            with open(target + ".redirect", encoding="utf-8") as handle:
                self._send(302, b"", {"Location": handle.read().strip()})
            return
        if not os.path.isfile(target):
            self._send(404, b"not found")
            return
        with open(target, "rb") as handle:
            body = handle.read()
        # API answers are stored without an extension, so sniff rather than guess from the name.
        kind = "application/json" if body[:1] in (b"{", b"[") else "application/octet-stream"
        self._send(200, body, {"Content-Type": kind})

    def do_GET(self):  # noqa: N802
        self._dispatch()

    def do_HEAD(self):  # noqa: N802
        self._dispatch()


def serve_files(port, certfile, keyfile, root):
    global FILES_ROOT
    FILES_ROOT = root
    httpd = ThreadingHTTPServer(("0.0.0.0", port), FilesHandler)
    httpd.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certfile, keyfile)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    print("files: serving %s over https on :%d" % (root, port), flush=True)
    httpd.serve_forever()


# ── Entry point ─────────────────────────────────────────────────────────────


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2

    mode = argv[1]
    if mode == "http":
        serve_http(int(argv[2]))
    elif mode == "https":
        serve_http(int(argv[2]), argv[3], argv[4])
    elif mode == "tcp":
        serve_tcp(int(argv[2]))
    elif mode == "udp":
        serve_udp(int(argv[2]))
    elif mode == "files":
        serve_files(int(argv[2]), argv[3], argv[4], argv[5])
    else:
        print("unknown mode %r" % mode, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    threading.stack_size(256 * 1024)
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(0)
