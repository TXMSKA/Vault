# Import formats

Checked against public documentation on 2026-10-07. The importer is written
here; no password manager code was copied. Files are UTF-8, capped at 8 MiB.
Column names are case-insensitive and normalize spaces, underscores and
hyphens. Required URL, username and password columns must exist, even when
their cells are empty. Extra documented export columns are ignored.

| Source | Accepted fields | Public documentation |
| --- | --- | --- |
| Chrome | `url`, `username`, `password`; optional `name`, `note` or `notes` | [Google Password Manager import and export](https://support.google.com/chrome/answer/13068232?hl=en) |
| Edge | Chromium CSV fields as above | [Export passwords in Microsoft Edge](https://support.microsoft.com/en-us/edge/export-passwords-in-microsoft-edge) |
| Firefox | `url`, `username`, `password`; additional browser metadata is ignored | [Export login data from Firefox](https://support.mozilla.org/en-US/kb/export-login-data-firefox) |
| Bitwarden CSV | `type`, `login_uri`, `login_username`, `login_password`; optional `name`, `notes`, `login_totp` | [Bitwarden custom file formats and examples](https://bitwarden.com/help/condition-bitwarden-import/) |
| Bitwarden JSON | Unencrypted `items` array; type 1, `name`, `notes`, `login.username`, `login.password`, `login.totp`, `login.uris[].uri` | [Bitwarden formats](https://bitwarden.com/help/condition-bitwarden-import/), [exports](https://bitwarden.com/help/export-your-data/) |
| 1Password CSV | `Title`, `Url` or `Website`, `Username`, `Password`; optional `Notes`, `OTPAuth` or `One-time password` | [1Password export fields](https://support.1password.com/export/) |
| KeePass CSV | `Account`, `Login Name`, `Password`, `Web Site`, `Comments`; generic `Title`, `User Name`, `URL`, `Notes` aliases also work | [KeePass import and export](https://keepass.info/help/base/importexport.html), [generic CSV](https://keepass.info/help/kb/imp_csv.html) |
| KeePassXC CSV | `Title`, `Username`, `Password`, `URL`, `Notes`; optional `TOTP`; group and timestamps are ignored | [KeePassXC user guide](https://keepassxc.org/docs/KeePassXC_UserGuide) |
| KeePass 2.x XML | `KeePassFile/Root/Group`, nested groups, current `Entry/String/Key` and `Value`: `Title`, `URL`, `UserName`, `Password`, `Notes`, optional `otp` | [KeePass XML format specification](https://github.com/keepassxreboot/keepassxc-specs/blob/master/kdbx-xml/rfc.md), [KeePass export](https://keepass.info/help/base/importexport.html) |

The browser documentation describes exporting CSV; Google's documentation
also names the three required credential columns. Vault accepts the shared
credential columns and ignores browser-specific metadata. The KeePassXC
guide was too large for the browsing tool to open in full; the documentation
index and search excerpt were available. Its CSV variant is covered by a
synthetic fixture alongside KeePass's documented CSV layout.

Quoted cells, escaped quotes, CRLF, LF, BOM and multiline cells are supported.
Unclosed quotes, trailing text after a quote, duplicate headers, wrong row
widths and invalid UTF-8 are refused. Parsing finishes before writes begin.
Errors contain no input values. A file can contain at most 10000 data rows;
only 4096 total vault entries can be stored.

KeePass XML is selected automatically with `--from keepass` when the text
starts with XML markup. The original reader accepts UTF-8 XML 1.0, comments,
CDATA, the five predefined entities and valid numeric character references.
DTD declarations, external or undeclared entities, processing instructions
other than the initial XML declaration, namespaces, malformed nesting,
duplicate attributes and invalid XML characters are refused. It caps depth
at 64, elements at 200000, attributes at 32 per element and text at 32000
characters per element, in addition to the 8 MiB file cap. Parsing finishes
before any entry is written.

Current entries require URL, UserName and Password string keys, even when
empty. Duplicate keys and nested value markup are refused. `ProtectInMemory`
is compatible with plaintext exports; `Protected` ciphertext is refused.
History, group metadata, attachments and custom fields other than `otp` are
ignored. KeePass 1.x XML, 1PUX and KDBX are not supported.

Duplicates use the exact stored website and username strings. Both existing
entries and earlier rows in the same file count. Non-login Bitwarden items
are skipped and counted; encrypted Bitwarden JSON is refused. A Bitwarden
login with multiple URIs produces one login per URI. Other import formats
create one login per row. Notes and TOTP are retained when those columns
exist; arbitrary custom fields, manager attachments and passkeys are not
imported. Login passwords are secret fields.

Plaintext source exports are left where the person put them. Vault reads
only the named file and does not scan browser profiles or other folders.
The service receives the parsed text through its authenticated import route;
it never receives an arbitrary local file path.
