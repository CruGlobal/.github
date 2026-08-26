# Changelog

## [2.1.1](https://github.com/CruGlobal/.github/compare/v2.1.0...v2.1.1) (2026-08-26)


### Bug Fixes

* disable provenance attestations on candidate builds ([#468](https://github.com/CruGlobal/.github/issues/468)) ([c8574da](https://github.com/CruGlobal/.github/commit/c8574da4bdb6eade0d70fcc85df7baddcedeb012))

## [2.1.0](https://github.com/CruGlobal/.github/compare/v2.0.2...v2.1.0) (2026-08-25)


### Features

* support pre-release (stage-only) apps in build-candidate and promote ([#466](https://github.com/CruGlobal/.github/issues/466)) ([3f6a643](https://github.com/CruGlobal/.github/commit/3f6a64311368c9b696a74f793207b3317bd6d25f))

## [2.0.2](https://github.com/CruGlobal/.github/compare/v2.0.1...v2.0.2) (2026-08-25)


### Bug Fixes

* **cloudrun:** retry transient gRPC failures on the deploy path ([#459](https://github.com/CruGlobal/.github/issues/459)) ([1fcbb16](https://github.com/CruGlobal/.github/commit/1fcbb16b00a8efa08bd8626c7ab871d035c4328f))

## [2.0.1](https://github.com/CruGlobal/.github/compare/v2.0.0...v2.0.1) (2026-08-11)


### Bug Fixes

* dependabot auto-merge gate never arms on repos with &gt;100 lifetime alerts ([#449](https://github.com/CruGlobal/.github/issues/449)) ([918aad3](https://github.com/CruGlobal/.github/commit/918aad38538f537475964fa64e1c2db11d3fb053))
* **deploy-ecs:** reduce SSM API bursts causing Rate exceeded errors ([#448](https://github.com/CruGlobal/.github/issues/448)) ([a634c72](https://github.com/CruGlobal/.github/commit/a634c72baae1bfe5d5a1a219d4b908985723730e))

## [2.0.0](https://github.com/CruGlobal/.github/compare/v1.10.0...v2.0.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* pipeline v2 — build once, promote the artifact ([#427](https://github.com/CruGlobal/.github/issues/427))

### Features

* pipeline v2 — build once, promote the artifact ([#427](https://github.com/CruGlobal/.github/issues/427)) ([06daf1f](https://github.com/CruGlobal/.github/commit/06daf1f1302ced3bb1f88f88c4c9f5493fc59ff0))

## [1.10.0](https://github.com/CruGlobal/.github/compare/v1.9.0...v1.10.0) (2026-08-05)


### Features

* add dependabot-auto-merge-security-patch reusable workflow ([#437](https://github.com/CruGlobal/.github/issues/437)) ([ccee50b](https://github.com/CruGlobal/.github/commit/ccee50b25e28d00c3949c69cca236e0ab3ad69aa))

## [1.9.0](https://github.com/CruGlobal/.github/compare/v1.8.1...v1.9.0) (2026-07-30)


### Features

* **aem-cloud-build:** add java-version input, default 11 ([#434](https://github.com/CruGlobal/.github/issues/434)) ([f4eccfe](https://github.com/CruGlobal/.github/commit/f4eccfe31cdbc8777ed5f9b59409f073d80a89e2))

## [1.8.1](https://github.com/CruGlobal/.github/compare/v1.8.0...v1.8.1) (2026-07-22)


### Bug Fixes

* **deploy:** post standard Datadog events instead of DORA product events ([#429](https://github.com/CruGlobal/.github/issues/429)) ([9ccbe73](https://github.com/CruGlobal/.github/commit/9ccbe73675120ec9361fa69e2e3f24d856a66c79))

## [1.8.0](https://github.com/CruGlobal/.github/compare/v1.1.0...v1.8.0) (2026-07-15)


### Bug Fixes

* **deploy:** replace removed 'deployment mark' with dora deployment; telemetry can no longer fail deploys ([36e3b29](https://github.com/CruGlobal/.github/commit/36e3b298c2d1b3a27d89f6dd39f429710ff1429c))
* **deploy:** replace removed 'deployment mark' with dora deployment; telemetry can't fail deploys ([e5e2483](https://github.com/CruGlobal/.github/commit/e5e248351243969f0e2004308bb7a417d5773862))
* **release-please:** exact-match tag rolling + bootstrap to 1.8.0 ([c409973](https://github.com/CruGlobal/.github/commit/c409973e315b5b14b0c51b57eb1493f3cb4e10c7))
* **release-please:** use exact ref match when rolling minor tag ([a4ded62](https://github.com/CruGlobal/.github/commit/a4ded62bb002374681cec7134b8a62e77aa8a84f))

## [1.1.0](https://github.com/CruGlobal/.github/compare/v1.0.0...v1.1.0) (2026-07-15)


### Features

* **deploy-cloudrun:** enable Datadog deploy tagging ([4d6eaa3](https://github.com/CruGlobal/.github/commit/4d6eaa3a00cbcaf7088f8628d3e17c5bd9d47aab))
* **deploy-cloudrun:** enable Datadog deploy tagging ([665700e](https://github.com/CruGlobal/.github/commit/665700ebd1473f24022e61e675f598ba9cc9b473))


### Bug Fixes

* **deploy-cloudrun:** preserve sidecar containers on deploy ([f988acb](https://github.com/CruGlobal/.github/commit/f988acb583bbebe9630d2fa3254d366bdc3c579a))
* **deploy-cloudrun:** preserve sidecar containers on deploy ([ed71724](https://github.com/CruGlobal/.github/commit/ed71724c9667b75db19de47cf9aee526de8c6b9a))
