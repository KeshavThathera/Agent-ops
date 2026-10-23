# VPN connection troubleshooting (CorpVPN)

Applies to: company laptops running the CorpVPN client 5.x. Owner: Network Team.

## Symptoms
- The VPN client shows "Connecting..." and then "Disconnected".
- Internal sites such as the intranet or file shares do not load while remote.
- The client reports AUTH_SESSION_EXPIRED or "Your session is no longer valid".

## Diagnose before changing anything
1. Confirm the laptop has general internet access (open any public website).
2. Check that the VPN gateway vpn.corp.example is reachable on port 443.
3. Check the VPN gateway service status. If the gateway is degraded, do not change the laptop; wait for the incident update.
4. Read the client's last error. AUTH_SESSION_EXPIRED means the stored session token is no longer accepted.

## Fix: expired VPN session token
If the gateway is reachable and operational but authentication fails with an expired session, refresh the VPN session
and re-apply the corp-default profile. This issues a new session token and reconnects the tunnel.
Refreshing the session changes client configuration, so a support engineer must approve it.

## Verify
After the fix, confirm the tunnel is up and an internal address such as intranet.corp.example responds.
Only resolve the ticket after this check passes.

## Escalate when
- The gateway service is degraded or down (Network Team incident).
- Authentication still fails after a session refresh (possible account issue; involve the Identity Team).
