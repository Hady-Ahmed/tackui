- Deployments that hit the #208 bug before this fix have orphan
  `organization` rows in their database (one per failed signup attempt —
  autocommitted by the old hook's app-pool write while the transaction
  rolled back). The fix stops new orphans but does not clean up existing
  ones. A data cleanup (delete `organization` rows with no `member` rows
  older than the fix) would need its own migration or operator script;
  kept out of scope here.
