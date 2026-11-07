# Database export incident response

Database dumps, seeds, backups, and compressed archives are operational artifacts, not application source or image inputs. The production PostgreSQL image initializes only the required extensions. Rorca application migrations run at API startup, and pg-boss creates and upgrades its own schema at worker startup.

## Repository and image containment

- Do not commit database exports in raw or compressed form.
- Keep exports outside the repository and Docker build contexts in access-controlled backup storage.
- The root ignore files reject common dump/archive forms. The PostgreSQL build context is allowlisted to `Dockerfile` and `init.sql` only.
- Static image-policy tests must pass before release. Do not weaken the allowlist to accommodate a seed or restore shortcut.
- No Rorca application migration may create, alter, seed, or restore `pgboss.*` objects.

## If an export was tracked

Deleting a file from the current tree does **not** erase it from existing Git objects, clones, caches, build caches, mirrors, releases, or remote history. Treat the artifact as disclosed to every principal and system that could read those copies.

1. Stop distributing builds or source archives that contain the artifact.
2. Preserve minimal path, commit, and access provenance without copying data rows into tickets, chat, logs, or reports.
3. Invalidate affected build caches and source archives through separately authorized operational procedures.
4. Identify credential, token, webhook-secret, private-key, and personal-data classes through an authorized incident process. Do not print or paste rows during triage.
5. Rotate or revoke affected credential/token material through a separately authorized provider and application ceremony. Source deletion is not rotation, and this repository change does not perform or claim rotation.
6. Decide whether remote history rewriting is necessary through the incident owner. History rewriting is disruptive, does not reach every prior clone, and is outside ordinary source remediation.
7. Record the containment and rotation evidence without storing secret preimages or private rows.

## Release evidence still required

Static source closure does not prove runtime initialization. Before production enablement, separately authorized staging must build the canonical PostgreSQL 16 image and prove that a genuinely fresh cluster contains only the required extensions, application migration state, and pg-boss bootstrap state—without user/workspace/run/integration seed rows. Dirty-upgrade, migration ordering, and pg-boss runtime checks remain required as separate staging evidence.
