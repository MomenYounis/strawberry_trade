import {runEmulatorTests} from './emulator-test-runner.mjs';
process.exitCode=await runEmulatorTests(['test/tenant-recovery.integration.test.mjs','test/firestore-recovery-quarantine.integration.test.mjs']);
