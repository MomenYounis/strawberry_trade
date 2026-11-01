import {runEmulatorTests} from './emulator-test-runner.mjs';
process.exitCode=await runEmulatorTests(['test/integration.test.mjs','test/shipment.test.mjs','test/invitation-signup.integration.test.mjs']);
