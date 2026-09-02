# Bridge reclaim processing

`BridgeReclaimProcessor` coordinates `BridgeReclaimRequested` events without
holding signing material in the worker. It verifies the destination-chain
failure through `BridgeLockVerificationWorker`, builds an unlock transaction
through an injected callback, broadcasts it through a second injected
callback, and remembers successful request IDs so replayed events do not
unlock funds twice.
