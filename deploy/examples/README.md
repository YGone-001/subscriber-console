# Configuration source declaration example

`config-snapshots.json` records reviewed file paths for the current lab
installation. The application has no built-in EPC/5GC or IMS configuration path.
Copy and review this example for each installation before setting
`CONFIG_SNAPSHOT_MANIFEST` to an operator-owned absolute path.

| Scope | Current example root | Files | Observation mode |
| --- | --- | --- | --- |
| EPC/5GC | `/usr/local/src/xcloud-5gs/install/etc` | 18 YAML and 5 Diameter CONF | Approved YAML fields, otherwise metadata only |
| IMS I-CSCF | `/etc/xCloud/gcc/icscf` | 4 | Metadata only |
| IMS P-CSCF | `/etc/xCloud/gcc/pcscf` | 26, including explicit route/SEMS files | Metadata only |
| IMS S-CSCF | `/etc/xCloud/gcc/scscf` | 5 | Metadata only |
| IMS SMSC | `/etc/xCloud/gcc/smsc` | 3 | Metadata only |

`<NE>` in `/etc/xCloud/gcc/<NE>` means the actual network-element type directory.
Future deployments may use different roots, NE sets and filenames. Review the
root(s) and every `path`; a directory declaration is not recursive discovery.
Keep collector/source UUIDs stable for the same installation and file identity.
Inventory resource UUIDs remain explicit, independent associations.

The original `root` is supported with optional additional `roots`. A declaration
may instead use only `roots`. Their combined count is at most 16; duplicate and
nested roots are rejected. Each file is read through its own resolved root.
No filesystem path or command is accepted from the browser.

IMS CFG/XML/CONF/LIST entries use `format: "text"` and
`profile: "metadata-only-v1"`. No original text is stored or displayed. Changes
can be observed through private fingerprints and version/baseline history;
visible IMS field differences require a future approved projection policy.

Schedules default to disabled. This example is not imported automatically and
contains no fingerprint key. See the [operations guide](../../docs/operations/configuration-observations.md)
for validation, activation and rollback.
