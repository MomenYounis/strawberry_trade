import {runEmulatorTests} from './emulator-test-runner.mjs';
process.exitCode=await runEmulatorTests(['test/annual-catalog.integration.test.mjs']);
