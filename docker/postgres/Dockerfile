FROM pgvector/pgvector:pg16

# Install one exact Apache AGE PG16 build from the signed PostgreSQL APT
# repository inherited by the pgvector image. APT verifies the package digest
# against its signed index, and the explicit dpkg check prevents version drift.
ARG APACHE_AGE_PACKAGE_VERSION=1.6.0~rc0-2.pgdg12+1
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      "postgresql-16-age=${APACHE_AGE_PACKAGE_VERSION}" && \
    test "$(dpkg-query -W -f='${Version}' postgresql-16-age)" = "${APACHE_AGE_PACKAGE_VERSION}" && \
    rm -rf /var/lib/apt/lists/*

# A fresh cluster receives extensions only. Rorca owns application migrations
# at server startup; pg-boss owns and bootstraps its own schema at worker start.
COPY init.sql /docker-entrypoint-initdb.d/010-extensions.sql
