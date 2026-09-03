import script from './cloak.js';
import {runCloakScript} from '@auto-bot/core';

runCloakScript(script).catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
