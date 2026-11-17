# Oleafly's trash patch

This directory contains `trash` 5.2.9 from crates.io. The upstream crate archive has SHA-256
`be89b3fe156965d29ac4f8522f3a640c655affdd9f21cb4f36857f0c92c00317`. Its MIT license is
preserved in `LICENSE.txt`.

Oleafly replaces the default `chrono` feature and dependency with `jiff` 0.2.46. The other package
contents are unchanged except for the Linux date conversion described below, the corresponding
crate tests, and this note.

On Linux, `DeletionDate` values are parsed as a `jiff::civil::DateTime`. The smaller helper keeps
the earlier instant when the local time occurs twice during a daylight-saving fold and rejects a
local time that falls inside a daylight-saving gap, matching Chrono's `earliest()` behavior. It
still stores `time_deleted` as Unix seconds. New `DeletionDate` values use
`jiff::Zoned::now().strftime("%Y-%m-%dT%H:%M:%S")`, which preserves the upstream output.

The crate tests use `jiff` for their current-time values. Their dev-dependency keeps Jiff's default
features and also enables `tzdb-bundle-always`, so fixed `America/New_York` normal, fold, and gap
cases do not depend on the machine's time zone or system tzdb. The Windows and macOS implementations
are unchanged. Keep this patch until upstream supports a maintained, non-`chrono` Linux date
implementation without losing `DeletionDate` metadata.
