# PostgreSQL Point-in-Time Recovery

## Prerequisites

- A PostgreSQL instance of the same major version as the source.
- The `pg_dump`/`pg_restore` client tools.
- AWS credentials with permission to read the backup bucket, and the configured KMS key for S3 downloads.
- The target database must be isolated from application traffic until recovery is complete.

The daily custom-format dump contains database objects and large objects, but does not contain cluster globals such as roles. Recreate required roles and privileges separately before restoring application data.

## Restore the latest backup

1. List the available offsite objects and select the required timestamp:

   ```bash
   aws s3 ls s3://BUCKET/PREFIX/ --region AWS_REGION
   ```

2. Download the object. S3 SSE-KMS decrypts on download when the caller can use the KMS key:

   ```bash
   aws s3 cp s3://BUCKET/PREFIX/pgdump_YYYYMMDDTHHMMSSZ.dump ./restore.dump --region AWS_REGION
   ```

3. Verify the file is a PostgreSQL custom archive, then restore into an empty database. `--clean` is destructive and should only be used on an isolated recovery database:

   ```bash
   pg_restore --list ./restore.dump
   createdb -h DB_HOST -U DB_USER recovered_stellarflow
   pg_restore --verbose --clean --if-exists --no-owner --no-acl \
     --dbname=postgresql://DB_USER:DB_PASSWORD@DB_HOST:5432/recovered_stellarflow \
     ./restore.dump
   ```

4. Recreate roles, grants, extensions, and application secrets as required. Run Prisma migrations only after confirming the restored schema is compatible; do not run `prisma db push` as part of an emergency restore.

5. Validate row counts and application health, then switch traffic to the recovered database. Preserve the original database until the recovery has been verified and approved.

## Recovery expectations

This process provides daily recovery points, not continuous WAL archiving. The maximum expected data loss is therefore the time since the last successful daily dump. Object Lock prevents deletion before the configured retention date; bucket lifecycle rules should be aligned with that retention period.

After a recovery exercise, record the selected object, restore duration, validation results, and any missing roles or grants.
