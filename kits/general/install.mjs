#!/usr/bin/env node
// Scripted equivalent of rulith kit install general.
import { installGeneral, parseKitInstall } from './installer.mjs';
try { console.log(installGeneral(parseKitInstall(process.argv.slice(2)))); }
catch (error) { console.error(error.message); process.exitCode = 2; }
