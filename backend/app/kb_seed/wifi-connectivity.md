# Office Wi-Fi connectivity (CORP-WIFI)

Applies to: company laptops on campus. Owner: Network Team.

## Symptoms
- No wireless networks are listed, or CORP-WIFI is missing.
- The network icon shows "No internet" or an airplane symbol.
- Colleagues nearby are connected, but this laptop is not.

## Diagnose
1. Check whether the wireless adapter is enabled. A disabled adapter (often switched off by a function key, airplane mode,
   or a driver update) means no networks appear at all.
2. If the adapter is enabled, check whether the laptop is associated with CORP-WIFI and has an IP address.
3. Check the wireless LAN controller status. If the controller is degraded, the issue affects many users; do not change the laptop.

## Fix: wireless adapter disabled
Enable the wireless network adapter and rejoin CORP-WIFI. Enabling the adapter changes device configuration and requires
approval by a support engineer in the prototype policy.

## Verify
Confirm the adapter is enabled, the laptop is associated with CORP-WIFI, and an HTTPS probe to the internet succeeds.

## Escalate when
- The adapter cannot be enabled (possible hardware fault; on-site support).
- The wireless controller reports an outage.
