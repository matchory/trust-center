# Audit sink — object-lock spike findings

Run 2026-09-04 against MinIO (`quay.io/minio/minio:latest`, digest
`sha256:a7fe349e…`, `mc` from `quay.io/minio/mc:latest`) on a bucket created with
`mc mb --with-lock` and a bucket-default retention of `governance 1d`.

The design document (§19) asks for two premises to be checked **against a real bucket and against
MinIO**. Only the MinIO half was run — see "What was not verified" at the end. Both premises hold on
MinIO, and a third question Task 7 needs answered was checked while the bucket was up.

## Premise one — a PUT to an existing key adds a version rather than being refused (§5.2)

**Verdict: holds.**

```
echo 'first'  | mc pipe s/audit/batch-1.ndjson; echo "exit1=$?"
echo 'second' | mc pipe s/audit/batch-1.ndjson; echo "exit2=$?"
mc ls --versions s/audit/batch-1.ndjson
mc cat s/audit/batch-1.ndjson
```

```
 0 B / ? 6 bytes -> `s/audit/batch-1.ndjson`
exit1=0
 0 B / ? 7 bytes -> `s/audit/batch-1.ndjson`
exit2=0
--- versions ---
[2026-09-04 20:57:31 UTC]     7B STANDARD edc35e77-c89a-4cd2-8db9-6992da3e66cd v2 PUT batch-1.ndjson
[2026-09-04 20:57:31 UTC]     6B STANDARD 8b69b6bb-8763-4613-9de6-2c8d8c6580f6 v1 PUT batch-1.ndjson
--- unversioned read ---
second
```

The second PUT succeeded, two versions exist, and the unversioned read returns the newer one. A
retry after a crash therefore lands, which is what §5.2's deterministic key strategy rests on.

**Consequence Task 7 must carry:** the older version is not replaced, it is retained under the same
lock. A retried batch leaves *two* locked objects at one key whose contents may differ — the
manifest digest is what distinguishes them, and a verifier reading the key without a version id sees
only the last write. §5.2's deterministic key is safe for shipping; it is not by itself an identity.

## Premise two — governance mode can be discharged with the bypass permission, and not without (§6.1)

**Verdict: holds.**

The first attempt was rejected by `mc` itself, client-side, before any request reached the server —
`Removal requires --force flag` — for both the bypass and the non-bypass case. That is `mc`'s own
guard and says nothing about the lock. Re-run with `--force`:

```
mc rm --versions --force s/audit/batch-1.ndjson
mc ls --versions s/audit/batch-1.ndjson
mc rm --versions --force --bypass s/audit/batch-1.ndjson
mc ls --versions s/audit/batch-1.ndjson
```

```
--- delete WITHOUT bypass (force) ---
mc: <ERROR> Failed to remove `s` recursively. Object, 'batch-1.ndjson (Version ID=edc35e77-…)' is WORM protected and cannot be overwritten
--- still present? ---
[2026-09-04 20:57:31 UTC]     7B STANDARD edc35e77-… v2 PUT batch-1.ndjson
[2026-09-04 20:57:31 UTC]     6B STANDARD 8b69b6bb-… v1 PUT batch-1.ndjson
--- delete WITH bypass (force) ---
Removed `s/audit/batch-1.ndjson` (versionId=edc35e77-…).
Removed `s/audit/batch-1.ndjson` (versionId=8b69b6bb-…).
--- after bypass ---
```

Without the bypass the object is WORM-protected and both versions survive; with it, both versions
are gone. Governance mode is therefore a lock the operator retains a key to, which is exactly what
§6.1's erasure-by-discharge argument needs and what §6 relies on when it declines compliance mode as
the default.

## Third finding — the bucket default applies to a plain PUT

Not one of the two premises, but Task 7 has to decide whether the adapter sends
`x-amz-object-lock-mode` and `x-amz-object-lock-retain-until-date` headers.

```
echo 'plain put, no lock headers' | mc pipe s/audit/batch-2.ndjson
mc retention info s/audit/batch-2.ndjson
```

```
Name    : s/audit/batch-2.ndjson
Mode    : GOVERNANCE, expiring in 23 hours 59 minutes
```

**The adapter should send no lock headers.** Retention is the bucket's configuration and therefore
the operator's decision, which is the division of responsibility §14 already documents. Sending
per-object retention would also require `s3:PutObjectRetention`, widening the write-only policy §5.2
depends on.

## What was not verified

**Neither premise was checked against a real Amazon S3 bucket** — that needs an AWS account and
credentials this working copy does not have. Both behaviours are what the S3 Object Lock
documentation specifies, and MinIO agrees with it here, but "documented and MinIO agrees" is weaker
than "we ran it". The residual: if Amazon refuses a re-PUT to a locked key, §5.2's retry path fails
in production against Amazon while every test passes against MinIO. Closing it needs one PUT, one
re-PUT and one `ls --versions` against a real locked bucket, and should happen before B1 is
deployed against Amazon rather than before it is written.
