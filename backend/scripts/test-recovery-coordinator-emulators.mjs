import {runEmulatorTests} from './emulator-test-runner.mjs';
process.exitCode=await runEmulatorTests(['test/recovery-coordinator.integration.test.mjs']);
