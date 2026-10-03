FROM tailscale/tailscale:v1.102.5@sha256:c507f3a2a6ab1cabd8d809b98edeb41edbd5c3fb6ad9632ffd098b4c7d0b4065
COPY client-start.sh /usr/local/bin/client-start.sh
RUN chmod +x /usr/local/bin/client-start.sh
ENTRYPOINT ["/usr/local/bin/client-start.sh"]
