# Pinned for reproducibility (Docker-ecosystem bumps stay manual — see AGENTS.md).
# pgBackRest is installed once here and is the only pgBackRest in the system, so
# archive-push / backup / restore can never drift across versions.
FROM timescale/timescaledb:2.27.1-pg16

USER root

# pgbackrest + jq live in Alpine's community repo. Append the matching-version
# community line (avoids mixing edge with the base image's Alpine release).
RUN set -eux; \
    echo "https://dl-cdn.alpinelinux.org/alpine/v$(cut -d. -f1,2 /etc/alpine-release)/community" >> /etc/apk/repositories; \
    apk add --no-cache pgbackrest jq bash su-exec

COPY pgbackrest-entrypoint.sh /usr/local/bin/pgbackrest-entrypoint.sh
COPY backup-scheduler.sh      /usr/local/bin/backup-scheduler.sh
COPY metrics-exporter.sh      /usr/local/bin/metrics-exporter.sh
COPY backup-bootstrap.sh      /usr/local/bin/backup-bootstrap.sh
RUN chmod +x /usr/local/bin/pgbackrest-entrypoint.sh \
             /usr/local/bin/backup-scheduler.sh \
             /usr/local/bin/metrics-exporter.sh \
             /usr/local/bin/backup-bootstrap.sh

ENTRYPOINT ["/usr/local/bin/pgbackrest-entrypoint.sh"]
