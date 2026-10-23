@echo off
rem Deep Rulith: the Rulith edition of DeepSeek Harness. Opens in the browser.
rem Settings: deep-rulith.json beside this file (copy deep-rulith.example.json and fill in the paths).
node "%~dp0harness\web\start-deep-rulith.mjs" "%~dp0deep-rulith.json" %*
