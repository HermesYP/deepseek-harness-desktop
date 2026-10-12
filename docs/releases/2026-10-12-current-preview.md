# Windows desktop preview: account and Updates repairs

This manual-download preview uses upstream Harness `0.1.7-rc.2` at
`477b4f420553e8a52c2fbccc464d7561b239c443`. It includes the browser sign-in,
account display/fallback and Settings Updates repairs recorded in the linked
reports. The native executable and preserved web shell were freshly built; the
pinned runtime dependency closure was retained, updated with the port plugins and
resealed. This is not a fresh registry reconstruction of that closure.

Extract the entire Windows x64 ZIP into a plain directory outside OneDrive and
keep `dsh` and `ui` beside `dsh-desktop.exe`. Quit older copies through Application
> Quit before launching. No system Node installation is required. A normal
launch uses the existing profile; back up important data before testing previews.

The package has no configured update feed or production signing keys, so Updates
explains the missing source and disables checking. Publishing a GitHub download
does not enable in-app updates. Native guests remain disabled. Account profile
refresh can still be refused by the platform. The 1.5-second cold-start target has
not been met. Native visual acceptance of Updates and a real installed upgrade
have not been qualified. The portable is unsigned.

Validation: 727 Rust tests passed with two existing ignored native tests; 227
updater-probe tests passed; strict Clippy and both relevant TypeScript checks
passed. The UI run covered 392 distinct tests; two stale count assertions were
fixed and the overlapping 57-test protocol suite passed. Installer contracts and
executed hook fixtures passed, as did 18 account regressions. The sealed Host
served the Updates client and real Cordis registered its section; native invoke
and slot adapters were fixture boundaries. ZIP extraction and inventory checks
are recorded separately when packaging.

See [Updates repair](../updates-repair-2026-10-12.md),
[account analysis](../account-data-analysis-2026-10-12.md) and
[sign-in repair](../desktop-signin-repair-2026-10-12.md).
