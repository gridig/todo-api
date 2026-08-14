# Pinned for reproducibility (Docker-ecosystem bumps stay manual — see AGENTS.md).
# Digest-pinned so rebuilds are byte-identical between deliberate bumps; keep in
# lockstep with the CI service image in .github/workflows/ci.yml.
# pgBackRest is installed once here and is the only pgBackRest in the system, so
# archive-push / backup / restore can never drift across versions.
FROM timescale/timescaledb:2.29.1-pg16@sha256:252a443e2936039b83dd8da1373d01e59e932d1054fa6adf1bc061f1d56ae60a

USER root

# pgbackrest + jq live in Alpine's community repo. Append the matching-version
# community line (avoids mixing edge with the base image's Alpine release).
# Deliberately no exact apk version pins: Alpine removes superseded package
# revisions from the branch repo, so exact pins break future rebuilds. The
# digest-pinned base fixes the branch; pgbackrest only moves within it on a
# security/bugfix revision. If a rebuild ever changes the pgbackrest minor,
# re-verify restore compatibility against the existing repo before deploying.
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
