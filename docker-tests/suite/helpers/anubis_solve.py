#!/usr/bin/env python3
"""Solves an Anubis proof-of-work challenge the way its page script does.

    anubis_solve.py < challenge-page.html

Reads the `anubis_challenge` JSON the page embeds and prints four lines: the challenge id, the
hash, the nonce, and the address Anubis recorded for the client. The "fast" and "slow"
algorithms differ only in how the browser computes it: sha256(randomData + nonce) in hex, with
`difficulty` leading zeros (lib/challenge/proofofwork in Anubis v1.27.0).
"""

import hashlib
import json
import re
import sys


def main():
    page = sys.stdin.read()
    match = re.search(r'<script[^>]*id="anubis_challenge"[^>]*>(.*?)</script>', page, re.S)
    if not match:
        print("no anubis_challenge script in the page", file=sys.stderr)
        return 1
    data = json.loads(match.group(1))
    challenge, rules = data["challenge"], data["rules"]
    if rules.get("algorithm") not in ("fast", "slow"):
        print("unsupported algorithm %r" % rules.get("algorithm"), file=sys.stderr)
        return 1

    prefix = "0" * int(rules["difficulty"])
    nonce = 0
    while True:
        digest = hashlib.sha256((challenge["randomData"] + str(nonce)).encode()).hexdigest()
        if digest.startswith(prefix):
            break
        nonce += 1

    print(challenge["id"])
    print(digest)
    print(nonce)
    print((challenge.get("metadata") or {}).get("X-Real-Ip", ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
