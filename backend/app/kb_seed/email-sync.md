# Email not syncing (Outlook)

Applies to: Outlook on company laptops. Owner: Collaboration Team.

## Symptoms
- New email does not arrive, or the status bar shows "Disconnected" or "Trying to connect".
- The last sync time is several hours old.
- The client reports SYNC_TOKEN_REJECTED.

## Diagnose
1. Confirm the laptop has internet connectivity.
2. Check the mail service status. If the mail service is degraded, wait for the incident update.
3. Read the mail client sync state and last error.

## Fix: stale sync profile cache
SYNC_TOKEN_REJECTED with an operational mail service usually means the local profile cache is stale.
Rebuild the mail client's sync profile cache so the client re-authenticates and performs a full sync.
This changes client configuration and requires engineer approval in the prototype policy.

## Verify
Confirm the sync state returns to "ok" and the last sync time is current.

## Escalate when
- Sync still fails after rebuilding the profile.
- Only shared mailboxes are affected (permissions issue).
