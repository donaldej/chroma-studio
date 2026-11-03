Vendored from https://github.com/ESP32Async/AsyncTCP/tree/v3.3.2.

Source, headers, package metadata and LICENSE are pinned to v3.3.2. This replaces
the original v1.1.1 transport to include upstream queue congestion/deadlock and
connection-lifecycle fixes needed by image/firmware uploads. The T-Embed build
keeps callbacks on core 0, a 16 KB stack and priority 3, matching the previous
radio isolation settings. Queue sizing/management use the upstream defaults.
