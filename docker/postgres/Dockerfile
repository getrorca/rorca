FROM pgvector/pgvector:pg16 AS age-builder

# Apache AGE's PG16 1.5.0 release source is immutable by commit and content
# digest. Keep this build at extension version 1.5.0 so an existing cluster does
# not load a different library beneath its unchanged pg_extension catalog row.
ARG APACHE_AGE_COMMIT=0048900f372d4dfd5c236f78b8a8453bcdbb458e
ARG APACHE_AGE_SOURCE_SHA256=bc2836b3588178b123095b4c8cf9398ad6174f571bcd975bbb844ffdebd2709a
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential bison ca-certificates curl file flex libreadline-dev \
      postgresql-server-dev-16 zlib1g-dev && \
    curl --fail --show-error --location --proto '=https' --tlsv1.2 \
      "https://codeload.github.com/apache/age/tar.gz/${APACHE_AGE_COMMIT}" \
      --output /tmp/apache-age.tar.gz && \
    echo "${APACHE_AGE_SOURCE_SHA256}  /tmp/apache-age.tar.gz" | sha256sum --check --strict && \
    mkdir -p /tmp/apache-age /opt/apache-age-runtime && \
    tar --extract --gzip --file /tmp/apache-age.tar.gz --directory /tmp/apache-age --strip-components=1 && \
    grep --quiet --line-regexp "default_version = '1.5.0'" /tmp/apache-age/age.control && \
    make -C /tmp/apache-age PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config -j"$(nproc)" && \
    make -C /tmp/apache-age PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config \
      DESTDIR=/opt/apache-age-runtime install && \
    test -s /opt/apache-age-runtime/usr/lib/postgresql/16/lib/age.so && \
    test -s /opt/apache-age-runtime/usr/share/postgresql/16/extension/age.control && \
    echo 'aba5f69b7d2cc86113509cdccfc2b26ba8eb7b9afa3d3b0f1cfc2d51da012f41  /opt/apache-age-runtime/usr/share/postgresql/16/extension/age--1.5.0.sql' \
      | sha256sum --check --strict && \
    case "$(dpkg --print-architecture):$(file -b /opt/apache-age-runtime/usr/lib/postgresql/16/lib/age.so)" in \
      amd64:*x86-64*|arm64:*aarch64*) ;; \
      *) echo 'Apache AGE library architecture mismatch' >&2; exit 1 ;; \
    esac && \
    install -D -m 0644 /tmp/apache-age/LICENSE /opt/apache-age-runtime/usr/share/doc/apache-age/LICENSE && \
    install -D -m 0644 /tmp/apache-age/NOTICE /opt/apache-age-runtime/usr/share/doc/apache-age/NOTICE

FROM pgvector/pgvector:pg16

COPY --from=age-builder /opt/apache-age-runtime/usr/lib/postgresql/16/lib/age.so /usr/lib/postgresql/16/lib/age.so
COPY --from=age-builder /opt/apache-age-runtime/usr/share/postgresql/16/extension/age.control /usr/share/postgresql/16/extension/age.control
COPY --from=age-builder /opt/apache-age-runtime/usr/share/postgresql/16/extension/age--1.5.0.sql /usr/share/postgresql/16/extension/age--1.5.0.sql
COPY --from=age-builder /opt/apache-age-runtime/usr/share/doc/apache-age/ /usr/share/doc/apache-age/

# Verify the final image contains only the exact runtime definition/library, not
# compiler inputs or an AGE 1.6 definition. The base supplies library runtime
# dependencies for PostgreSQL; no build package is installed in this stage.
RUN grep --quiet --line-regexp "default_version = '1.5.0'" /usr/share/postgresql/16/extension/age.control && \
    echo 'aba5f69b7d2cc86113509cdccfc2b26ba8eb7b9afa3d3b0f1cfc2d51da012f41  /usr/share/postgresql/16/extension/age--1.5.0.sql' \
      | sha256sum --check --strict && \
    test "$(find /usr/share/postgresql/16/extension -maxdepth 1 -type f -name 'age--*.sql' -printf '%f\n')" = 'age--1.5.0.sql' && \
    ! ldd /usr/lib/postgresql/16/lib/age.so | grep -q 'not found' && \
    for package in build-essential bison flex postgresql-server-dev-16; do \
      status="$(dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null || true)"; \
      test "$status" != 'ii ' || exit 1; \
    done

# A fresh cluster receives extensions only. Rorca owns application migrations
# at server startup; pg-boss owns and bootstraps its own schema at worker start.
COPY init.sql /docker-entrypoint-initdb.d/010-extensions.sql
