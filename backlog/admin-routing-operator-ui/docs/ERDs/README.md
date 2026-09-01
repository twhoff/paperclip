# Adapter Selection V2 ERD intake receipt

## Classification

This directory is an immutable archival companion to the proposed, unratified
[Adapter Selection V2 spec](../specs/027-adapter-selection-v2.md). It belongs in
the existing [extracted Paperclip/pcli backlog snapshot](../../../README.md), not
in Paperclip's current `doc/` product contract.

The ERD describes a conceptual Paperclip/pcli routing model. It does not declare
implemented schema, ratify spec 027, activate the ON HOLD operator UI, or replace
the current sources of truth in `doc/SPEC-implementation.md` and the running
codebase.

## Receipt

| Field | Value |
| --- | --- |
| Intake issue | `pcl-y5w` |
| Source repository | `tizzi-app` |
| Source path | `docs/ERDs/adapter-selection-v2.md` |
| Archived path | `backlog/admin-routing-operator-ui/docs/ERDs/adapter-selection-v2.md` |
| SHA-256 | `b06457d340f29091dc990c446173ed164842e7a1f8cccd77ff64be9c771b073e` |
| Byte count | `15398` |
| Source removal context | `TIZA-1218`, commits `87ecce75` and `5ce8d58a` |
| Intake date | `2026-09-01` |

The archived Markdown file is byte-for-byte identical to the Tizzi source at
intake. Provenance and classification stay in this receipt so the archived
source bytes remain independently hash-verifiable.

## Ownership rationale

- The model joins Paperclip-owned agent/config-revision concepts with
  pcli-owned optimiser evaluation, health, metrics, and routing-state concepts.
- The only existing consumer reference is spec 027 inside this already
  extracted `admin-routing-operator-ui` snapshot.
- The snapshot's root classification is ON HOLD and says spec 027 was proposed
  but never ratified. Archiving the missing dependency repairs provenance
  without promoting it into current product truth.
- The Tizzi source remains untouched. This intake authorises neither its
  deletion nor restoration of the removed Tizzi spec.

## Verification contract

Reviewers can verify the preserved artifact with:

```sh
shasum -a 256 backlog/admin-routing-operator-ui/docs/ERDs/adapter-selection-v2.md
wc -c backlog/admin-routing-operator-ui/docs/ERDs/adapter-selection-v2.md
```

Expected results are the SHA-256 and byte count recorded above. All relative
Markdown links in this receipt and the repaired spec reference resolve within
the snapshot.
