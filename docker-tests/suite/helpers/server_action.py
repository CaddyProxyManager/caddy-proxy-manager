#!/usr/bin/env python3
"""Calls a dashboard server action the way the browser does, for flows with no REST route.

    server_action.py BASE COOKIE_JAR PAGE ACTION [--form] [key=value ...]

The action id is `<hash>#<export>`, fixed per build, so it is read from the page's own client
chunks. Arguments are React's `encodeReply` shape: `--form` sends `(null, FormData)`, which is what
`useActionState` passes; without it the action is called with no arguments. Prints the action's
return value as JSON; exits 2 when the action threw or could not be found.
"""
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

CHUNK = re.compile(r"/_next/static/[A-Za-z0-9._/-]+\.js")
RELATIVE = re.compile(r"[\"'`](\./[A-Za-z0-9._-]+\.js)[\"'`]")
MAX_CHUNKS = 600


def cookie_header(jar_path):
    """curl's jar, whose `#HttpOnly_` lines Python's MozillaCookieJar would skip."""
    pairs = []
    with open(jar_path, encoding="utf-8") as jar:
        for line in jar:
            line = line.rstrip("\n")
            if line.startswith("#HttpOnly_"):
                line = line[len("#HttpOnly_"):]
            elif not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) == 7:
                pairs.append(f"{fields[5]}={fields[6]}")
    return "; ".join(pairs)


def get(url, cookies):
    request = urllib.request.Request(url, headers={"Cookie": cookies})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", "replace")


def find_action_id(base, cookies, page, action):
    wanted = re.compile(r"[\"'`]([0-9a-f]{6,}#" + re.escape(action) + r")[\"'`]")
    queue = [base + path for path in dict.fromkeys(CHUNK.findall(get(base + page, cookies)))]
    seen = set()
    while queue and len(seen) < MAX_CHUNKS:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            source = get(url, cookies)
        except urllib.error.URLError:
            continue
        match = wanted.search(source)
        if match:
            return match.group(1)
        directory = url.rsplit("/", 1)[0]
        queue.extend(directory + rel[1:] for rel in RELATIVE.findall(source))
        queue.extend(base + path for path in CHUNK.findall(source))
    return None


def multipart(fields):
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in fields:
        body += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        ).encode()
    return body + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def main():
    args = sys.argv[1:]
    base, jar, page, action = args[:4]
    rest = args[4:]
    form = "--form" in rest
    pairs = [item.split("=", 1) for item in rest if item != "--form"]
    cookies = cookie_header(jar)

    action_id = find_action_id(base, cookies, page, action)
    if not action_id:
        print(f"no client chunk of {page} references {action}", file=sys.stderr)
        return 2

    if form:
        # encodeReply: the root row is field 0; a FormData argument's entries follow as `_<ref>_<key>`.
        fields = [("0", json.dumps([None, "$K1"]))] + [(f"_1_{k}", v) for k, v in pairs]
        body, content_type = multipart(fields)
    else:
        body, content_type = b"[]", "text/plain;charset=UTF-8"

    request = urllib.request.Request(
        base + page,
        data=body,
        method="POST",
        headers={
            "Cookie": cookies,
            "Origin": base,
            "Accept": "text/x-component",
            "x-rsc-action": action_id,
            "Content-Type": content_type,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", "replace")

    for line in payload.splitlines():
        if line.startswith("0:"):
            result = json.loads(line[2:]).get("returnValue", {})
            print(json.dumps(result.get("data")))
            return 0 if result.get("ok") else 2
    print(f"no return value in the response: {payload[:300]}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
