# The managed CrowdSec image with its hub content baked in: the rig's network has no egress, so the
# first start could not download the collections docker-compose.yml asks for. Same digest as there.
FROM crowdsecurity/crowdsec:v1.8.1@sha256:0f2523fa61ef507f15d953045cface490cc880670c62f2755ced17524107f71a

# Installed into the staging trees the entrypoint copies from on a first start, so a fresh container
# finds them already there. The whitelists parser drops private addresses, which is all the rig has.
# A fixed hub branch spares every later cscli call the version lookup, which fails offline.
RUN set -eux; \
    cp -a /staging/etc/crowdsec /etc/crowdsec; \
    mkdir -p /var/lib/crowdsec/data; \
    cp -a /staging/var/lib/crowdsec/data/. /var/lib/crowdsec/data/; \
    cscli hub update --with-content; \
    cscli collections install crowdsecurity/caddy crowdsecurity/appsec-virtual-patching \
      crowdsecurity/appsec-generic-rules; \
    cscli parsers install crowdsecurity/docker-logs crowdsecurity/cri-logs; \
    cscli parsers remove crowdsecurity/whitelists --force; \
    yq e -i '.cscli.hub_branch = "master"' /etc/crowdsec/config.yaml; \
    rm -rf /staging/etc/crowdsec /staging/var/lib/crowdsec/data; \
    mv /etc/crowdsec /staging/etc/crowdsec; \
    mv /var/lib/crowdsec/data /staging/var/lib/crowdsec/data; \
    mkdir -p /var/lib/crowdsec/data

COPY docker/crowdsec/acquis.yaml /staging/etc/crowdsec/acquis.d/cpm.yaml
