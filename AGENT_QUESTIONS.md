- The issue's caller policy names only `PATCH /api/catalog/[id]`, but `withKeyedLock`
  has TWO production callers — the credentials PUT route (`app/api/credentials/route.ts`)
  is the other one (both are named as the lock's hot paths in the commit that
  introduced the primitive, 9140d17). I applied the same 503-with-existing-copy
  mapping to the credentials PUT per the issue's stated rationale ("a queued-forever
  failure and a timeout failure should never look like an unexpected server error").
  Please confirm, or revert `app/api/credentials/route.ts` (+ its test) to the
  generic 500 if only the catalog route was intended.
