# Slow laptop performance

Applies to: company Windows laptops. Owner: Endpoint Team.

## Symptoms
- Applications take a long time to open, or the laptop freezes intermittently.
- The fan runs constantly and the device feels hot.

## Diagnose
1. Read CPU, memory and disk usage, and identify the top process.
2. A runaway SearchIndexer process combined with very low free disk space (below 10%) is a common cause.

## Fix: clear temporary files and restart the indexer
Clear temporary files to free disk space and restart the search indexing service. This changes device state and requires
engineer approval in the prototype policy.

## Verify
Confirm CPU usage returns below 70% and free disk space is above 10%. Because responsiveness is partly subjective,
also ask the user to confirm the laptop feels responsive before resolving.

## Escalate when
- Performance stays poor with normal counters (possible hardware or disk health issue).
