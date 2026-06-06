# deploy/

Operator artifacts for running clagentic-console as a managed system service.

## clagentic-console.service

Systemd unit file for the Clagentic Console daemon.

- **Unit name:** `clagentic-console.service` (matches clagentic-brand CLI naming standard)
- **SyslogIdentifier:** `clagentic-console` — use this for log filtering: `journalctl -u clagentic-console`
- **ExecStart:** `/usr/local/bin/clagentic-daemon.sh` — wrapper that resolves the global npm install path
- **Restart policy:** `Restart=always` — daemon restarts on any exit, including update handoffs
- **Memory limits:** `MemoryHigh=70%` (soft reclaim ceiling) / `MemoryMax=85%` (hard per-service OOM trigger)
- **OOM policy:** `OOMPolicy=kill` — on OOM, all cgroup members are killed together; no orphaned child processes

### Requirements

- systemd 240+ (percentage-based memory limits). Ubuntu 22.04+ qualifies.
- cgroup v2 (required for `MemoryMax` + `OOMPolicy`). Verify with: `cat /sys/fs/cgroup/cgroup.controllers`

### Fresh install

```bash
cp deploy/clagentic-console.service /etc/systemd/system/clagentic-console.service
systemctl daemon-reload
systemctl enable clagentic-console.service
systemctl start clagentic-console.service
systemctl status clagentic-console.service
```

### Rename cutover (clagentic.service → clagentic-console.service)

**Order matters.** The running daemon is tracked in the old unit's cgroup. An in-app update
triggers `gracefulShutdown()` followed by `Restart=always` — if the old unit is still active
when this happens, systemd restarts it under `clagentic.service`, not the new unit. Stop the
old unit first, then start the new one.

```bash
# 1. Install the new unit file
cp deploy/clagentic-console.service /etc/systemd/system/clagentic-console.service
systemctl daemon-reload

# 2. Enable new, disable old (no start/stop yet)
systemctl enable clagentic-console.service
systemctl disable clagentic.service

# 3. Stop old unit (takes the daemon down briefly)
systemctl stop clagentic.service

# 4. Start under new unit
systemctl start clagentic-console.service

# 5. Verify
systemctl status clagentic-console.service
systemctl show clagentic-console.service --property=MemoryHigh,MemoryMax,OOMPolicy,SyslogIdentifier

# 6. Remove old unit file
rm /etc/systemd/system/clagentic.service
systemctl daemon-reload
```

After step 4, in-app updates work correctly: `gracefulShutdown()` → systemd restarts under
`clagentic-console.service`.

### Verify memory limits are active

```bash
systemctl show clagentic-console.service --property=MemoryHigh,MemoryMax,OOMPolicy
# Expected:
# MemoryHigh=<bytes, ~70% of total RAM>
# MemoryMax=<bytes, ~85% of total RAM>
# OOMPolicy=kill
```

### Update the unit file after changes

```bash
cp deploy/clagentic-console.service /etc/systemd/system/clagentic-console.service
systemctl daemon-reload
# No restart needed for most changes — takes effect on next service restart
# Exception: changes to ExecStart or Environment require a restart
```
