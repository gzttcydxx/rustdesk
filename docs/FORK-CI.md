# Building this fork

Upstream only builds on pushes to `master` (`ci.yml`, `flutter-ci.yml`), so a
customization branch gets no build at all. This fork adds its own entry point.

## Chain

```
fork-build.yml                        push on feat/no-login-address-book, or manual
  └── fork-flutter-build.yml          copy of flutter-build.yml
        ├── fork-bridge.yml           copy of bridge.yml
        └── fork-third-party-RustDeskTempTopMostWindow.yml
```

All four files are verbatim copies of their upstream counterparts. The only
edits are the `uses:` targets (repointed at the `fork-*` siblings) and, in the
three reusable files, a `push` trigger added to the `on:` block. There is no
other structural change, so when upstream touches `flutter-build.yml` the four
files have to be re-copied by hand.

`fork-flutter-build.yml` builds every platform upstream supports (Windows,
Linux, Android, iOS, macOS, AppImage, Flatpak). It is long: expect hours.

## Signing

This fork has none of the signing secrets upstream uses
(`ANDROID_SIGNING_KEY`, `MACOS_P12_BASE64`, `SIGN_BASE_URL`, ...). Upstream
gates every signing step on those being present, so signing is skipped rather
than failing. Only unsigned artifacts are produced. Add the secrets to the fork
to get signed builds.

## Why the `fork-*` copies exist at all

A fork inherits its parent's workflow files, but they are **not** in the fork's
Actions registry, so a local `uses: ./.github/workflows/flutter-build.yml`
resolves to nothing and the run dies as `startup_failure` with 0 jobs and 0s.

Worse, a newly added workflow file does not reach the registry by being pushed
either. It gets there only when a push **matches one of its triggers**, so that
GitHub actually schedules it. `workflow_call` and `workflow_dispatch` do not
count, and neither does a `push` filter that cannot match the pushed branch.
Measured with two throwaway files, identical except for their push filter:

| file | push filter | registered |
| --- | --- | --- |
| `fork-probe-match.yml` | `feat/no-login-address-book` | yes |
| `fork-probe-mismatch.yml` | `ci/never-pushed-anywhere` | no |

Both also carried `workflow_call` and `workflow_dispatch`.

That is a chicken-and-egg problem for a file that is only ever *called*: it is
never scheduled, so it never gets registered, so the call cannot resolve. Hence
each of the three reusable files carries

```yaml
  push:
    branches:
      - "ci/register-workflows"
```

## Registering after adding or renaming a `fork-*` file

```sh
git push fork <sha>:refs/heads/ci/register-workflows
```

That single matching push is what puts the files in the registry. Push that
branch again after any `fork-*` file is added or renamed, or the build goes back
to dying as `startup_failure`. The branch is otherwise never pushed, so the
trigger does not fire during normal work and causes no duplicate builds.

Expect that push to start three runs. They are a side effect of registering, not
the build you want:

- `Build the flutter version of the RustDesk` runs, but without `inputs`, so
  every job gated on `if: ${{ inputs.upload-artifact }}` is skipped and no
  artifacts are uploaded. The intended build is the one `fork-build.yml` starts.
- `Build flutter-rust-bridge` runs normally; its job only uses matrix values.
- `build RustDeskTempTopMostWindow` fails, because its only job is
  `runs-on: ${{ inputs.target }}` and a bare `push` supplies no inputs. Called
  over `workflow_call` the caller passes a target and it works.

## Checking whether a file is registered

```sh
gh workflow view fork-flutter-build.yml --repo gzttcydxx/rustdesk
```

`could not find any workflows named ...` means it is not in the registry.
