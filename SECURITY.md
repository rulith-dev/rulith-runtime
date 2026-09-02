# Security

## Report a vulnerability

Do not open a public issue for a vulnerability involving credentials, cross-tenant
access, command execution, source access, or receipt forgery. Email
`security@rulith.ai` with a minimal reproduction and affected version. Do not include
live customer data or reusable credentials.

## Credential placement

- Keep `RULITH_TOKEN` and model credentials in the Agent Runtime environment.
- Keep `RULITH_CONNECTION_KEY` and source credentials on the Worker machine.
- Do not put passwords, tokens, private keys, or DSNs with embedded passwords in
  capability packages, recipes, board facts, Rulith Local configuration committed to Git,
  or issue reports.
- Rulith Local creates `~/.rulith/local.json` with mode `0o600` and its directory with
  `0o700`. POSIX systems enforce that; **Windows ignores the mode bits**, so on Windows
  the file inherits the parent directory's ACL and is readable by any process running as
  the same user and by administrators. Restrict it yourself, or keep credentials in the
  deployment environment instead of the file.

## Network boundary

Agent Runtime and Worker use outbound connections. The Local UI listens on loopback
only and requires a random per-run key. Do not publish that port
through a reverse proxy or bind them to a public interface.

Loopback is not an authorization boundary: every process on the machine can reach it.
The per-run key is what separates them, so every route — including the page at `/` —
requires it. A request without the key is refused with 401 and a request with a
non-loopback `Host` or a cross-origin `Origin` with 403, before any response body is
produced. The key appears only in the URL that Rulith Local prints at startup and in
the browser tab opened from it; the page contains no embedded copy.

## Tool boundary

Treat every capability package as code-adjacent configuration. Review tool and source
declarations before installation. Prefer read-only source credentials, narrowly scoped
Connection identities, explicit host allowlists, and fixed `run` commands.

Open source makes the local execution path inspectable; it does not replace server-side
identity, authorization, leases, replay protection, clearance, or verification.
