import { createSimHost, type MessagePortLike } from '@aquarium/sim';

// The web app compiles against the DOM lib, where `self` is a Window; these calls are the
// structurally identical DedicatedWorkerGlobalScope ones.
const port: MessagePortLike = {
  postMessage: (message, transfer) => self.postMessage(message, { transfer }),
  addEventListener: (type, listener) => self.addEventListener(type, listener),
  removeEventListener: (type, listener) => self.removeEventListener(type, listener),
};

createSimHost(port);
