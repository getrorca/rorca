-- Rorca PostgreSQL initialization
-- Runs once on first container start via /docker-entrypoint-initdb.d/

-- pgcrypto: gen_random_uuid() and crypto functions. Pin it before AGE changes
-- search_path so constrained migration owners never need accidental AGE-schema
-- authority merely to create the application digest wrappers.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- pgvector: vector similarity search for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Apache AGE: graph database layer
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;
