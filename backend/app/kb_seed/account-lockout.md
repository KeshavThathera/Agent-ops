# Directory account lockout

Applies to: employee directory accounts. Owner: Identity Team.

## Symptoms
- Sign-in fails with "Your account has been locked" or "Too many failed attempts".
- The user recently changed their password and an old password is cached on a phone or laptop.

## Policy
Accounts lock after 5 failed sign-in attempts within 30 minutes. Unlocking an account is a sensitive identity action:
it requires approval by a support engineer, and the engineer must record how the requester's identity was verified.
Never ask the user for their password.

## Diagnose
1. Read the account status: locked flag and failed-attempt count.
2. Check the identity provider status. If the identity service is degraded, many users are affected; do not unlock individual accounts.

## Fix: unlock the account
After identity verification, unlock the directory account and require a password change at the next sign-in.
Remind the user to update saved passwords on other devices to avoid an immediate re-lock.

## Verify
Run a test sign-in bind for the account. Resolve only when the account is unlocked and the test succeeds.

## When to reject or escalate
- Identity cannot be verified: reject the unlock and route to the Identity Team.
- Repeated lockouts from unknown locations: treat as a possible security incident.
