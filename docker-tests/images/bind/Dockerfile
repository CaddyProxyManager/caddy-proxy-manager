# BIND, authoritative for rfc.cpm.test and open to RFC 2136 updates signed with the rig's TSIG
# key: the server a DNS-01 challenge through the rfc2136 provider writes its TXT records to.
FROM internetsystemsconsortium/bind9:9.20@sha256:f8506cfcbc8fcb44e40b922fa74b481ba23b50f00482bf6693ff8f120709a778

COPY named.conf /etc/bind/named.conf
# Where named may write the journal a dynamic update needs; a new container starts from this copy.
COPY --chown=bind:bind db.rfc.cpm.test /var/lib/bind/db.rfc.cpm.test

ENTRYPOINT ["/usr/sbin/named", "-u", "bind"]
CMD ["-g", "-c", "/etc/bind/named.conf"]
