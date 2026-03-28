FROM pgvector/pgvector:pg16

# Build Apache AGE extension from source (no prebuilt package for PG16)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      git \
      libreadline-dev \
      zlib1g-dev \
      flex \
      bison \
      postgresql-server-dev-16 && \
    GIT_SSL_NO_VERIFY=true git clone --branch release/PG16/1.5.0 --depth 1 https://github.com/apache/age.git /tmp/age && \
    cd /tmp/age && \
    make && make install && \
    cd / && rm -rf /tmp/age && \
    apt-get purge -y --auto-remove build-essential git libreadline-dev zlib1g-dev flex bison postgresql-server-dev-16 && \
    rm -rf /var/lib/apt/lists/*

# Embed pre-prod seed data — restored automatically on first container start.
# seed.sql.gz excludes: embeddings, spec_search_index, queue_health_snapshots,
# run_output_chunks, story_output_chunks, memories (vector embeddings stripped).
# Postgres entrypoint processes .sql.gz files in initdb.d automatically.
COPY seed.sql.gz /docker-entrypoint-initdb.d/seed.sql.gz
