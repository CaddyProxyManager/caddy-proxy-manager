# curl with HTTP/3, which Alpine's (the runner's) is built without and Debian's is built with, run
# on the runner's behalf: POST /curl {"args": [...], "ca": "<PEM>"} -> {"rc", "stdout", "stderr"}.
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -V | grep -q HTTP3

COPY h3.py /srv/h3.py
ENV PYTHONUNBUFFERED=1
CMD ["python3", "/srv/h3.py"]
