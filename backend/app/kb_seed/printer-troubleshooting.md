# Printer offline or showing an error

Applies to: networked office printers on PRINT-01. Owner: Workplace Services.

## Symptoms
- The printer shows "Offline" in the print dialog.
- Jobs remain in the queue and never print.
- The printer panel shows a numeric error code.

## Diagnose
1. Read the printer status and error code.
2. Check the print server status.
3. Check the queue length and whether the spooler is running.

## Software fixes
If the printer reports no hardware fault and the queue is stuck, restarting the print spooler and clearing the queue
usually restores printing.

## Hardware faults
Error codes in the 50.x range (for example "50.2 Fuser error") indicate a fuser hardware fault. These cannot be fixed
remotely. Do not repeatedly restart the spooler. Route the case to on-site hardware support and advise users to use
the nearest alternative printer.

## Verify
Print a test page. Resolve only after a technician confirms the device prints correctly.
