// The app launcher's first step (start-deep-rulith.mjs: hold the app home), and then it stays running like the app does.
// Run through rulith-start.mjs, so `process.argv` is what the launcher sees when it is started with `rulith`.
import { holdAppHome } from '../../../harness/web/app-home.mjs';

await holdAppHome(process.argv[2]);
console.log('held');
setInterval(() => {}, 1000);
