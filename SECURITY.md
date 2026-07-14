# Security

Archiv is a personal, local-first project. It is designed to reduce the risk of losing Venice content, not to provide a hardened multi-user or remote service. It has not had an independent security audit.

## Security model

- The app reads a stability-checked copy of a Brave or Chrome profile. It does not write to the live profile or restore data into Venice.
- The library listens only on a loopback address. It rejects non-local `Host` headers, cross-site state-changing requests and file paths that resolve outside the archive.
- Browser extraction runs in a temporary isolated clone. It opens `https://venice.ai/` so that Venice's own browser code can access the copied origin storage, then removes the temporary workspace.
- The extension is optional. Its restore and storage-write paths remain disabled.

This model assumes the operating-system account, browser executable, repository code and archive inputs are trusted. The project is not designed for a shared host, untrusted archive ZIPs, hostile browser profiles, remote network exposure or serving an archive to other users.

## Archive sensitivity

An archive can contain private conversations, uploads, generated media and lossless browser-source data. Raw snapshots can also contain Venice cookies, authentication material and other origin state. Treat an archive as you would a browser profile:

- keep it private and restrict filesystem access;
- use full-disk encryption and protect any backup destination;
- understand the retention and sharing settings of cloud-synced folders;
- do not attach an archive, snapshot, capture or diagnostic dump to a public issue;
- revoke Venice sessions and credentials if an archive is exposed.

The optional extension keeps detected Venice recovery keys in its extension-local browser storage. They are not placed in Chrome Sync, but anyone who can read the browser profile or control the extension context should be treated as able to access them.

## Supported versions

Security fixes are made on the latest `main` branch only. There is no promise of long-term support or a security response time.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** route when it is available. If it is not available, open a minimal issue asking for a private contact channel; do not include exploit details, credentials or personal archive data in the issue.

Include the affected commit or version, operating system, browser, reproduction steps and impact. Please use synthetic test data wherever possible.
