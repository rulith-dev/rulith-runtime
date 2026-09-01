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
- Restrict local configuration files to the operating-system account that runs the
  process.

## Network boundary

Agent Runtime and Worker use outbound connections. The Local UI listens on loopback
only and requires a random per-run key. Do not publish that port
through a reverse proxy or bind them to a public interface.

## Tool boundary

Treat every capability package as code-adjacent configuration. Review tool and source
declarations before installation. Prefer read-only source credentials, narrowly scoped
Connection identities, explicit host allowlists, and fixed `run` commands.

Open source makes the local execution path inspectable; it does not replace server-side
identity, authorization, leases, replay protection, clearance, or verification.
