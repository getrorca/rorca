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
    git clone --branch release/PG16/1.5.0 --depth 1 https://github.com/apache/age.git /tmp/age && \
    cd /tmp/age && \
    make && make install && \
    cd / && rm -rf /tmp/age && \
    apt-get purge -y --auto-remove build-essential git libreadline-dev zlib1g-dev flex bison postgresql-server-dev-16 && \
    rm -rf /var/lib/apt/lists/*
