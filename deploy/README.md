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

**Order matters — stop the old unit before starting the new one.**

The running daemon is tracked in the old unit's cgroup under `Restart=always`. An in-app
update triggers `gracefulShutdown()`; systemd immediately attempts a restart under whichever
unit owns the cgroup at that moment. `enable`/`disable` only affect boot-time wants — they
do not close this window. The old unit must be stopped first so no restart can fire under it.

```bash
# 1. Install the new unit file
cp deploy/clagentic-console.service /etc/systemd/system/clagentic-console.service
systemctl daemon-reload

# 2. Enable new, disable old
systemctl enable clagentic-console.service
systemctl disable clagentic.service

# 3. Stop old unit FIRST — brief downtime starts here.
#    Do not trigger an in-app update between steps 2 and 3.
systemctl stop clagentic.service

# 4. Start under new unit — downtime ends here
systemctl start clagentic-console.service

# 5. Verify
systemctl status clagentic-console.service
systemctl show clagentic-console.service --property=MemoryHigh,MemoryMax,OOMPolicy,SyslogIdentifier

# 6. Remove old unit file
rm /etc/systemd/system/clagentic.service
systemctl daemon-reload
```

After step 4 (and the old unit file removed at step 6), in-app updates work correctly:
`gracefulShutdown()` → systemd restarts under `clagentic-console.service`.

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
```

`daemon-reload` is always required after editing a unit file. Whether a service restart is
also needed depends on what changed:

- `MemoryHigh` / `MemoryMax` / `OOMPolicy` — require a service restart to apply to the
  running cgroup (daemon-reload alone does not update live cgroup limits).
- `Environment=` — requires a service restart (env vars are set at process start).
- `ExecStart` / `Restart*` / `TimeoutStopSec` — require a service restart.
- `[Unit]` and `[Install]` metadata — daemon-reload is sufficient; no restart needed.
