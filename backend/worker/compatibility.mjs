/** Pinned SDK packaging shim; public schemas only, no secrets or network I/O. */
import '@google-cloud/firestore-api';
import fallbackGax from './node_modules/@google-cloud/firestore-api/node_modules/google-gax/build/src/fallback.js';
import firestoreFallbackGax from 'google-gax/fallback';
import protobuf from 'protobufjs';
import firestoreProtos from './node_modules/@google-cloud/firestore-api/build/protos/protos.json';
import locationProtos from './node_modules/google-gax/build/protos/locations.json';
import nestedLocationProtos from './node_modules/@google-cloud/firestore-api/node_modules/google-gax/build/protos/locations.json';
import statusProtos from './node_modules/google-gax/build/protos/status.json';
import nestedStatusProtos from './node_modules/@google-cloud/firestore-api/node_modules/google-gax/build/protos/status.json';
import adminPackage from './node_modules/firebase-admin/package.json';
import firestorePackage from './node_modules/@google-cloud/firestore/package.json';
import gaxPackage from './node_modules/google-gax/package.json';
import nestedGaxPackage from './node_modules/@google-cloud/firestore-api/node_modules/google-gax/package.json';
import protobufPackage from './node_modules/protobufjs/package.json';

if (adminPackage.version !== '14.5.0' || firestorePackage.version !== '9.3.1' ||
    gaxPackage.version !== '6.12.1' || nestedGaxPackage.version !== '5.0.8' ||
    protobufPackage.version !== '7.6.6') {
  throw Error('worker_dependency_review_required');
}

let warmedTypes = 0;
function warmTypes(namespace) {
  for (const type of namespace.nestedArray || []) {
    if (type.fieldsArray && type.setup) {type.setup(); void type.ctor; warmedTypes++;}
    warmTypes(type);
  }
}
for (const gax of [fallbackGax, firestoreFallbackGax]) {
  for (const json of [firestoreProtos, locationProtos, nestedLocationProtos]) {
    const root = gax.GrpcClient.protobufFromJSON(json);
    root.resolveAll();
    warmTypes(root);
  }
}

// Gax otherwise constructs a new reflective protobuf Root on every HTTP error,
// which triggers forbidden request-time codegen and incorrectly retries errors.
// Only these exact immutable bundled schema identities reuse a startup Root.
const staticStatusRoots = new WeakMap();
for (const json of [statusProtos, nestedStatusProtos]) {
  const root = protobuf.Root.fromJSON(json);
  root.resolveAll();
  warmTypes(root);
  staticStatusRoots.set(json, root);
}
const originalFromJson = protobuf.Root.fromJSON;
protobuf.Root.fromJSON = function(json, root, depth) {
  return !root && staticStatusRoots.has(json)
    ? staticStatusRoots.get(json) : originalFromJson(json, root, depth);
};
export const warmedSchemaTypes = warmedTypes;
