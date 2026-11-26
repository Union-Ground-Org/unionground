# Security Policy

Union Ground holds sensitive information about workers and their
organizations, so we take security reports seriously and thank everyone who
sends one.

## Reporting a vulnerability

**Do not report security vulnerabilities in public issues, pull requests or
discussions.**

Report them privately through GitHub:

1. Go to this repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, the affected version or commit, how to reproduce it,
   and what an attacker could do with it. A proof of concept helps.

This opens a private security advisory that only you and the maintainers can
see. We will work on the fix with you there and can add you as a collaborator
on the advisory.

When you test, use your own installation or a local copy. Do not test against
the official hosted service or other people's servers, do not access, change
or delete data that is not yours, and do not run denial-of-service or social
engineering tests.

## Supported versions

Security fixes are made on the latest commit of the default branch (`main`).
Older commits, tags and releases do not receive backported fixes; if you run
your own installation, update to the latest `main` to get them.

## What happens after you report

| Step | Target |
| --- | --- |
| We acknowledge your report | within 3 business days |
| We confirm the problem and its severity, or explain why it is not a vulnerability | as soon as we can, usually within 10 business days |
| We fix confirmed vulnerabilities | within 90 days of the report |
| Public disclosure | after the fix is released, coordinated with you |

We will keep you updated while we work, and tell you if a fix will take
longer than 90 days and why.

## How fixes are released

Union Ground LLC runs the official hosted Union Ground service. Fixes are
deployed to the official hosted service **before** the vulnerability is
disclosed publicly, so that its users are protected first. The fix then lands
in this repository and the advisory is published, with credit to you unless
you ask to stay anonymous.

If you run your own installation, watch this repository's security advisories
to hear about fixes.

## Scope

In scope: the code in this repository (the web app, the API, the database
migrations and policies, and the phone apps).

Out of scope: vulnerabilities in third-party dependencies that are already
public (report those upstream), and reports that only concern installations
run by other people (contact whoever runs that installation).
