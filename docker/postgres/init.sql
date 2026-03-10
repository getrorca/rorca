-- Rorca PostgreSQL initialization
-- Runs once on first container start via /docker-entrypoint-initdb.d/

-- pgvector: vector similarity search for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Apache AGE: graph database layer
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;

-- pgcrypto: gen_random_uuid() and crypto functions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
