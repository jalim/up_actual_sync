# UP Bank to Actual Budget Sync

Features:
1) Automatically sync on a schedule (defaults to hourly)
2) WebUI for configuration changes and to manually trigger sync.

Environment variables:
- port - port for the webUI to listen on (default: 3000)
- cronEnabled - enable the built in cron schedule (default: false)
- webUI - enable the webUI (default: false)
- configFile - name and location of the configuration file.


Early stages of a simple node js app to sync UP Bank transactions with Actual Budget.
