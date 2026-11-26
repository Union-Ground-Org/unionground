# Releases

Union Ground LLC publishes each release from this repository by pushing a tag
that starts with `v` (for example `v1.0.0`). The
[`release`](../.github/workflows/release.yml) workflow then:

1. checks out the tagged commit, runs `npm ci` and `npm run build` with
   official branding (`VITE_OFFICIAL_BRANDING=1`, the files in
   `branding/official/`);
2. packs `dist/` into `unionground-<tag>-web.tar.gz` (sorted, owner-free,
   every file dated to the tagged commit);
3. generates the CycloneDX software bills of materials with
   `scripts/generate-sbom.mjs` (`unionground-<tag>-<target>.cdx.json`) and a
   `SHA256SUMS` file;
4. attests every file with GitHub's build provenance
   (`actions/attest-build-provenance`, pinned to a commit), signed with the
   run's own OIDC identity through Sigstore;
5. creates the GitHub release with those files.

The workflow has only the permissions it needs (`contents: write`,
`id-token: write`, `attestations: write`) and runs only in
`Union-Ground-Org/unionground`.

## Verify a download

With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify unionground-v1.0.0-web.tar.gz --repo Union-Ground-Org/unionground
```

Do the same for each `.cdx.json` file and for `SHA256SUMS`, then check the
files against the sums:

```sh
gh attestation verify SHA256SUMS --repo Union-Ground-Org/unionground
sha256sum --check SHA256SUMS
```

A file passes only if it was built by this repository's release workflow from
the tagged commit. A file that fails, or that came from anywhere else, is not
an official Union Ground release.

## Copies

Releases from this repository carry the Union Ground name and mark, which
belong to Union Ground LLC ([`TRADEMARKS.md`](../TRADEMARKS.md)). If you
build and publish your own copy, build it unbranded with your own
`VITE_BRAND_NAME`, point `SOURCE_CODE_URL` at your own source code, and sign
it with your own repository's identity.
